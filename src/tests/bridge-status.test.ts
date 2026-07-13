import { Buffer } from "buffer";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { TransactionReceiptNotFoundError, encodeAbiParameters, encodeEventTopics } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";

import { classifyAvailableMessage, refreshStatus } from "../bridge-status";
import { BRIDGE_ABI, CONFIG } from "../config";
import * as shared from "../shared";
import * as solanaHelpers from "../solana";

const txHash = `0x${"11".repeat(32)}` as const;

afterEach(() => vi.restoreAllMocks());

function bridgeReceipt() {
  const mint = new PublicKey(new Uint8Array(32).fill(0x22));
  const destination = new PublicKey(new Uint8Array(32).fill(0x33));
  const messageBytes = Buffer.alloc(98);
  messageBytes[0] = 1;
  messageBytes[1] = 1;
  Buffer.alloc(20, 0x44).copy(messageBytes, 2);
  mint.toBuffer().copy(messageBytes, 22);
  destination.toBuffer().copy(messageBytes, 54);
  messageBytes.writeBigUInt64LE(1_250_000n, 86);
  const messageData = `0x${messageBytes.toString("hex")}` as const;
  const messageHash = `0x${"55".repeat(32)}` as const;
  const mmrRoot = `0x${"66".repeat(32)}` as const;
  const sender = `0x${"77".repeat(20)}` as const;
  const topics = encodeEventTopics({
    abi: BRIDGE_ABI,
    eventName: "MessageInitiated",
    args: { messageHash, mmrRoot }
  });
  const data = encodeAbiParameters([{
    type: "tuple",
    components: [
      { name: "nonce", type: "uint64" },
      { name: "sender", type: "address" },
      { name: "data", type: "bytes" }
    ]
  }], [{ nonce: 5n, sender, data: messageData }]);
  return {
    receipt: {
      blockNumber: 700n,
      logs: [{ address: CONFIG.baseBridge, topics, data }]
    },
    messageData,
    mint
  };
}

function mockReadyReads(incomingData: Buffer | null = null) {
  const { receipt, messageData, mint } = bridgeReceipt();
  const baseClient = {
    getTransactionReceipt: vi.fn().mockResolvedValue(receipt),
    readContract: vi.fn().mockResolvedValue("TEST")
  };
  vi.spyOn(shared, "getBaseClient").mockReturnValue(baseClient as never);
  vi.spyOn(solanaHelpers, "getSolanaBridgeState").mockResolvedValue({
    bridge: new PublicKey(new Uint8Array(32).fill(0x88)),
    baseBlockNumber: 900n,
    blockIntervalRequirement: 300n,
    paused: false
  });
  vi.spyOn(solanaHelpers, "readMintInfo").mockResolvedValue({
    owner: solanaHelpers.TOKEN_PROGRAM_ID,
    decimals: 6,
    tokenProgramLabel: "Standard SPL Token"
  });
  vi.spyOn(shared.solana, "getAccountInfo").mockResolvedValue(incomingData
    ? {
        data: incomingData,
        owner: new PublicKey(CONFIG.solanaBridgeProgram),
        lamports: 1,
        executable: false,
        rentEpoch: 0
      } as never
    : null);
  return { messageData, mint };
}

function classify(input: {
  incomingExecuted?: boolean | null;
  latestRootBlock?: bigint;
  baseBlockNumber?: bigint;
  paused?: boolean;
}) {
  const baseBlockNumber = input.baseBlockNumber ?? 700n;
  const latestRootBlock = input.latestRootBlock ?? 900n;
  return classifyAvailableMessage({
    common: {
      txHash,
      baseBlockNumber,
      solanaBaseBlockNumber: latestRootBlock,
      bridgePaused: input.paused ?? false
    },
    incomingExecuted: input.incomingExecuted ?? null,
    latestRootBlock,
    blockIntervalRequirement: 300n
  });
}

describe("available bridge message classification", () => {
  it("reports an executed incoming message as claimed even while paused", () => {
    const status = classify({ incomingExecuted: true, paused: true });
    expect(status.status).toBe("claimed");
    expect(status.bridgePaused).toBe(true);
  });

  it("reports an unexecuted proof account as relayable", () => {
    expect(classify({ incomingExecuted: false }).status).toBe("proof_created");
  });

  it("keeps proof status visible but explains that a paused bridge cannot relay", () => {
    const status = classify({ incomingExecuted: false, paused: true });
    expect(status.status).toBe("proof_created");
    expect(status.humanStatus).toMatch(/bridge is paused/i);
  });

  it("reports a covered Base block as ready", () => {
    expect(classify({ latestRootBlock: 900n, baseBlockNumber: 700n }).status).toBe("ready_to_claim");
  });

  it("keeps ready status visible but explains that a paused bridge cannot claim", () => {
    const status = classify({ latestRootBlock: 900n, baseBlockNumber: 700n, paused: true });
    expect(status.status).toBe("ready_to_claim");
    expect(status.humanStatus).toMatch(/bridge is paused/i);
  });

  it("reports output-root progress while waiting, including during a pause", () => {
    const status = classify({ latestRootBlock: 600n, baseBlockNumber: 700n, paused: true });
    expect(status.status).toBe("waiting_for_root");
    expect(status.nextEligibleRootBlock).toBe(900n);
    expect(status.rootBlocksBehind).toBe(300n);
    expect(status.humanStatus).toMatch(/status checks remain available/i);
  });
});

describe("refreshStatus orchestration", () => {
  it("classifies a missing receipt as pending", async () => {
    const pending = new TransactionReceiptNotFoundError({ hash: txHash });
    vi.spyOn(shared, "getBaseClient").mockReturnValue({
      getTransactionReceipt: vi.fn().mockRejectedValue(pending)
    } as never);

    await expect(refreshStatus(txHash)).resolves.toMatchObject({ status: "waiting_for_base_tx" });
  });

  it("reports a mined transaction without a bridge event", async () => {
    vi.spyOn(shared, "getBaseClient").mockReturnValue({
      getTransactionReceipt: vi.fn().mockResolvedValue({ blockNumber: 700n, logs: [] })
    } as never);

    await expect(refreshStatus(txHash)).resolves.toMatchObject({ status: "not_bridge_tx" });
  });

  it("assembles a ready-to-claim status from Base and Solana reads", async () => {
    const { mint } = mockReadyReads();

    await expect(refreshStatus(txHash)).resolves.toMatchObject({
      status: "ready_to_claim",
      displayAmount: "1.25 TEST",
      transfer: { amount: 1_250_000n, localMint: mint }
    });
  });

  it("detects an already executed incoming message", async () => {
    const { messageData } = bridgeReceipt();
    const messageLength = Buffer.from(messageData.slice(2), "hex").length;
    const accountData = Buffer.alloc(8 + 20 + 4 + messageLength + 1);
    Buffer.from([30, 144, 125, 111, 211, 223, 91, 170]).copy(accountData);
    accountData[8 + 20 + messageLength] = 1;
    mockReadyReads(accountData);

    await expect(refreshStatus(txHash)).resolves.toMatchObject({ status: "claimed" });
  });

  it("treats a prefunded system-owned incoming PDA as an absent proof", async () => {
    mockReadyReads();
    vi.mocked(shared.solana.getAccountInfo).mockResolvedValue({
      data: Buffer.alloc(0),
      owner: SystemProgram.programId,
      lamports: 890_880,
      executable: false,
      rentEpoch: 0
    } as never);

    await expect(refreshStatus(txHash)).resolves.toMatchObject({ status: "ready_to_claim" });
  });

  it("propagates non-pending RPC failures", async () => {
    vi.spyOn(shared, "getBaseClient").mockReturnValue({
      getTransactionReceipt: vi.fn().mockRejectedValue(new Error("RPC unavailable"))
    } as never);

    await expect(refreshStatus(txHash)).rejects.toThrow(/RPC unavailable/);
  });
});
