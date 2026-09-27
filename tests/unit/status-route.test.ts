import { address } from "@solana/kit";
import { encodeAbiParameters, encodeEventTopics, type PublicClient } from "viem";
import { describe, expect, it } from "vitest";

import { BRIDGE_ABI } from "../../src/chain/base";
import type { SolanaRpc } from "../../src/chain/solana";
import { NETWORK } from "../../src/config";
import { parseAmount, routeKey } from "../../src/core/route";
import { estimateRootEta, parseTxHash, ROOT_REGISTRATION_DELAY_SECONDS, trackTransaction } from "../../src/core/status";
import { choosePriorityFee, MAX_PRIORITY_FEE, MIN_PRIORITY_FEE, priorityFeeLamports } from "../../src/core/fees";
import { describeError, explainTransactionError } from "../../src/core/errors";
import { addressToBytes } from "../../src/protocol/bytes";
import { SYSTEM_PROGRAM } from "../../src/protocol/constants";
import { fromBase64, mainnet, message } from "../helpers";

// ---------------------------------------------------------------------------------------------
// Fakes built from real mainnet bytes
// ---------------------------------------------------------------------------------------------

type Accounts = Record<string, { owner: string; data: Uint8Array; lamports?: bigint } | null>;

function fakeSolana(accounts: Accounts): SolanaRpc {
  const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
  return {
    getMultipleAccounts: (addresses: string[]) => ({
      send: async () => ({
        value: addresses.map((key) => {
          const account = accounts[key];
          return account ? { owner: account.owner, lamports: account.lamports ?? 1_000_000n, data: [b64(account.data), "base64"], executable: false } : null;
        })
      })
    })
  } as unknown as SolanaRpc;
}

function receiptFor(fixture: ReturnType<typeof message>, overrides: Partial<{ status: string; logs: unknown[] }> = {}) {
  const topics = encodeEventTopics({ abi: BRIDGE_ABI, eventName: "MessageInitiated", args: { messageHash: fixture.messageHash, mmrRoot: `0x${"00".repeat(32)}` } });
  const data = encodeAbiParameters([{ type: "tuple", components: [{ type: "uint64" }, { type: "address" }, { type: "bytes" }] }], [[fixture.nonce, fixture.sender, fixture.data]]);
  return {
    status: "success",
    blockNumber: fixture.baseBlock,
    from: fixture.from,
    logs: [{ address: NETWORK.base.bridge, topics, data }],
    ...overrides
  };
}

function fakeBase(receipt: unknown, extras: Partial<Record<"symbol" | "finalized", unknown>> = {}): PublicClient {
  return {
    getTransactionReceipt: async () => {
      if (receipt === null) throw Object.assign(new Error("not found"), { name: "TransactionReceiptNotFoundError" });
      return receipt;
    },
    readContract: async () => extras.symbol ?? "TEST",
    getBlock: async () => ({ number: (extras.finalized as bigint) ?? 0n })
  } as unknown as PublicClient;
}

const bridgeAccount = () => ({ owner: NETWORK.solana.bridgeProgram, data: fromBase64(mainnet.bridge.data) });
const hash = message("spl").txHash;

async function trackWith(receipt: unknown, accounts: Accounts, extras = {}) {
  const { findBridgePda } = await import("../../src/protocol/instructions");
  const bridgePda = await findBridgePda(NETWORK.solana.bridgeProgram);
  return trackTransaction({ txHash: hash, base: fakeBase(receipt, extras), rpc: fakeSolana({ [bridgePda]: bridgeAccount(), ...accounts }) });
}

describe("tracking a Base transaction", () => {
  it("classifies missing, reverted and non-bridge transactions", async () => {
    expect((await trackWith(null, {})).state).toBe("not-found");
    expect((await trackWith(receiptFor(message("spl"), { status: "reverted" }), {})).state).toBe("reverted");
    expect(await trackWith(receiptFor(message("spl"), { logs: [] }), {})).toMatchObject({ state: "not-a-bridge-tx", reason: "no-event" });
    const receipt = receiptFor(message("spl"));
    expect(await trackWith({ ...receipt, logs: [...receipt.logs, ...receipt.logs] }, {})).toMatchObject({ state: "not-a-bridge-tx", reason: "multiple-events" });
  });

  it("reads a real claimed transfer as claimed", async () => {
    const fixture = message("spl");
    const decoded = (await import("../../src/protocol/message")).decodeBridgeMessage((await import("viem")).hexToBytes(fixture.data));
    if (decoded.type !== "transfer" || decoded.transfer.kind !== "spl") throw new Error("fixture must be an SPL transfer");
    const accounts = {
      [fixture.incomingAddress]: { owner: NETWORK.solana.bridgeProgram, data: fromBase64(fixture.incomingMessage.data) },
      [decoded.transfer.mint]: { owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", data: fromBase64(mainnet.mints[0].data) }
    };
    const status = await trackWith(receiptFor(fixture), accounts, { symbol: "neet" });
    expect(status).toMatchObject({ state: "claimed", asset: { symbol: "neet" }, recipientWallet: null }); // token account not found

    // The recipient wallet is the owner recorded in the destination token account.
    const tokenData = fromBase64(mainnet.vaults[0].data);
    tokenData.set(addressToBytes(decoded.transfer.mint), 0); // a token account for this transfer's mint
    const tokenAccount = { owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", data: tokenData };
    const withAccount = await trackWith(receiptFor(fixture), { ...accounts, [decoded.transfer.to]: tokenAccount }, { symbol: "neet" });
    expect(withAccount).toMatchObject({ recipientWallet: mainnet.vaults[0].address });

    // A destination that isn't a token account leaves the recipient unknown instead of failing the status.
    const notTokenAccount = { owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", data: fromBase64(mainnet.mints[0].data) };
    const odd = await trackWith(receiptFor(fixture), { ...accounts, [decoded.transfer.to]: notTokenAccount }, { symbol: "neet" });
    expect(odd).toMatchObject({ state: "claimed", recipientWallet: null });
  });

  it("treats an unproven message as ready once a covering root exists, and waits otherwise", async () => {
    const fixture = message("sol");
    const ready = await trackWith(receiptFor(fixture), { [fixture.incomingAddress]: null });
    expect(ready).toMatchObject({ state: "ready", asset: { symbol: "SOL", decimals: 9 } });
    if (ready.state !== "ready") throw new Error("expected ready");
    expect(ready.recipientWallet).toBe(ready.transfer.to); // SOL returns name the wallet itself

    const prefunded = await trackWith(receiptFor(fixture), { [fixture.incomingAddress]: { owner: SYSTEM_PROGRAM, data: new Uint8Array(), lamports: 5n } });
    expect(prefunded.state).toBe("ready");

    const later = { ...receiptFor(fixture), blockNumber: BigInt(mainnet.outputRoot.block) + 10n };
    const waiting = await trackWith(later, { [fixture.incomingAddress]: null }, { finalized: BigInt(mainnet.outputRoot.block) });
    expect(waiting).toMatchObject({ state: "waiting-for-root", eta: { eligibleRootBlock: BigInt(mainnet.outputRoot.block) + 300n } });
  });

  it("marks an unexecuted proof account as proven", async () => {
    const fixture = message("sol");
    const data = fromBase64(fixture.incomingMessage.data).slice();
    data[data.length - 5] = 0; // executed flag sits right after the message bytes
    expect((await trackWith(receiptFor(fixture), { [fixture.incomingAddress]: { owner: NETWORK.solana.bridgeProgram, data } })).state).toBe("proven");
  });

  it("validates hashes", () => {
    expect(() => parseTxHash("0x1234")).toThrow(/64 hex/);
    expect(parseTxHash(`  ${hash}  `)).toBe(hash);
  });

  it("estimates the root ETA from Base finality", () => {
    const eta = estimateRootEta(1_000n, 1_000n, 300n);
    expect(eta.eligibleRootBlock).toBe(1_200n);
    expect(eta.seconds).toBe(200 * NETWORK.base.blockTimeSeconds + ROOT_REGISTRATION_DELAY_SECONDS);
    expect(estimateRootEta(1_200n, 5_000n, 300n).seconds).toBe(ROOT_REGISTRATION_DELAY_SECONDS);
  });
});

describe("amounts and route keys", () => {
  it("parses amounts strictly", () => {
    expect(parseAmount("1.5", 6)).toBe(1_500_000n);
    expect(() => parseAmount("1,5", 6)).toThrow(/plain number/); // a decimal comma must not become 15
    expect(() => parseAmount("", 6)).toThrow(/Enter an amount/);
    expect(() => parseAmount("0", 6)).toThrow(/greater than zero/);
    expect(() => parseAmount("1.1234567", 6)).toThrow(/6 decimal/);
    expect(() => parseAmount("1e3", 6)).toThrow(/plain number/);
    expect(() => parseAmount("-1", 6)).toThrow(/plain number/);
    expect(() => parseAmount("18446744073709551616", 0)).toThrow(/larger than the bridge/);
  });

  it("changes the route key when any input changes", () => {
    const base = { token: "0xABC", amount: "1", evm: "0xDEF", solana: address("11111111111111111111111111111111") };
    const key = routeKey(base);
    expect(routeKey({ ...base, token: "0xabc" })).toBe(key);
    for (const change of [{ amount: "2" }, { evm: "0x123" }, { solana: "Sysvar1111111111111111111111111111111111111" }, { token: "0xabd" }]) {
      expect(routeKey({ ...base, ...change })).not.toBe(key);
    }
  });
});

describe("fees and errors", () => {
  it("chooses a clamped 75th-percentile priority fee", () => {
    expect(choosePriorityFee([])).toBe(MIN_PRIORITY_FEE);
    expect(choosePriorityFee([0n, 0n, 0n])).toBe(MIN_PRIORITY_FEE);
    expect(choosePriorityFee([10n ** 12n])).toBe(MAX_PRIORITY_FEE);
    expect(choosePriorityFee([20_000n, 40_000n, 60_000n, 80_000n, 100_000n])).toBe(80_000n);
    expect(priorityFeeLamports(200_000, 50_000n)).toBe(10_000n);
  });

  it("describes wallet rejections and rate limits plainly", () => {
    expect(describeError({ code: 4001, message: "User rejected the request." }).message).toMatch(/rejected the request in your wallet/);
    expect(describeError(new Error("HTTP 429 Too Many Requests")).message).toMatch(/rate limiting/);
  });

  it("names bridge errors only when the bridge program raised them", () => {
    const programs = ["ComputeBudget111111111111111111111111111111", NETWORK.solana.bridgeProgram];
    expect(explainTransactionError({ InstructionError: [1, { Custom: 12400 }] }, programs)).toMatch(/InvalidProof/);
    expect(explainTransactionError({ InstructionError: [0, { Custom: 12400 }] }, programs)).not.toMatch(/InvalidProof/);
    expect(explainTransactionError("InsufficientFundsForFee", programs)).toMatch(/enough SOL/);
    expect(explainTransactionError({ InstructionError: [1, "Custom"] }, programs, ["Transfer: insufficient lamports 5, need 10"])).toMatch(/enough SOL/);
  });
});

describe("error names from program logs", () => {
  it("reads the Anchor error name and number from logs", async () => {
    const { explainLogs } = await import("../../src/core/errors");
    expect(explainLogs(["Program log: AnchorError occurred. Error Code: AlreadyExecuted. Error Number: 12501. Error Message: Already executed."])).toMatch(/already been claimed.*AlreadyExecuted/);
    expect(explainLogs(["Program log: AnchorError occurred. Error Code: Spoofed. Error Number: 12501."])).toBeUndefined();
    expect(explainLogs(["unrelated"])).toBeUndefined();
  });
});
