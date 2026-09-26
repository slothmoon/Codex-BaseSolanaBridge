import {
  appendTransactionMessageInstruction,
  blockhash,
  compileTransaction,
  decompileTransactionMessage,
  generateKeyPairSigner,
  getCompiledTransactionMessageDecoder,
  getPublicKeyFromAddress,
  getTransactionDecoder,
  getTransactionEncoder,
  partiallySignTransaction,
  verifySignature,
  type Address,
  type KeyPairSigner,
  type Transaction
} from "@solana/kit";
import { getSetComputeUnitPriceInstruction } from "@solana-program/compute-budget";
import { describe, expect, it, vi } from "vitest";

import { containsInOrder, executeClaim, validateWalletSignature, type PreparedClaim, type SolanaSigner } from "../../src/core/claim";
import { planClaim, type ClaimPlan } from "../../src/core/claim-plan";
import type { SolanaRpc } from "../../src/chain/solana";
import { buildTransaction } from "../../src/core/tx";
import { hasPrefix } from "../../src/protocol/bytes";
import { INSTRUCTION_DISCRIMINATORS } from "../../src/protocol/constants";
import { findBridgePda, findOutputRootPda, relayRemainingAccounts } from "../../src/protocol/instructions";
import { decodeBridgeMessage } from "../../src/protocol/message";
import { hexToBytes, bytesToHex } from "viem";
import { mainnet, message, program } from "../helpers";

const encoder = getTransactionEncoder();
const decoder = getTransactionDecoder();

function walletFor(keys: KeyPairSigner, tamper?: (tx: Transaction) => Transaction | Promise<Transaction>): SolanaSigner {
  return {
    address: keys.address,
    supportsV1: false,
    async signTransaction(wire) {
      let tx = decoder.decode(wire) as Transaction;
      if (tamper) tx = await tamper(tx);
      const signed = await partiallySignTransaction([keys.keyPair], tx as never);
      return new Uint8Array(encoder.encode(signed));
    }
  };
}

type FakeOptions = {
  simulate?: (index: number) => { err: unknown; logs?: string[]; unitsConsumed?: bigint };
  status?: (signature: string) => { err: unknown; confirmationStatus: string } | null;
  blockHeight?: bigint;
};

function fakeRpc(options: FakeOptions = {}) {
  const sent: string[] = [];
  let simulations = 0;
  const rpc = {
    getLatestBlockhash: () => ({ send: async () => ({ value: { blockhash: blockhash("GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi"), lastValidBlockHeight: 100n } }) }),
    simulateTransaction: () => ({ send: async () => ({ value: options.simulate?.(simulations++) ?? { err: null, logs: [], unitsConsumed: 50_000n, loadedAccountsDataSize: 900_000 } }) }),
    sendTransaction: (wire: string) => ({ send: async () => { sent.push(wire); return "sig"; } }),
    getSignatureStatuses: (signatures: string[]) => ({ send: async () => ({ value: [options.status ? options.status(signatures[0]) : { err: null, confirmationStatus: "confirmed" }] }) }),
    getBlockHeight: () => ({ send: async () => options.blockHeight ?? 10n })
  };
  return { rpc: rpc as unknown as SolanaRpc, sent };
}

async function prepared(payer: Address, plan: ClaimPlan): Promise<PreparedClaim> {
  const fixture = message("spl");
  return {
    status: { event: { messageHash: fixture.messageHash } } as never,
    payer,
    plan,
    priorityFee: 20_000n,
    findings: [],
    destination: { address: payer, created: false },
    rootBlock: BigInt(mainnet.outputRoot.block),
    cost: { networkFees: 0n, newAccountRent: 0n, refundableRent: 0n, required: 0n, balance: 10n ** 9n }
  };
}

async function planFor(payer: Address, proofLength: number, force?: ClaimPlan["strategy"]) {
  const fixture = message("spl");
  const data = hexToBytes(fixture.data);
  const decoded = decodeBridgeMessage(data);
  if (decoded.type !== "transfer") throw new Error();
  return planClaim(
    {
      program,
      payer,
      bridge: await findBridgePda(program),
      incomingMessage: fixture.incomingAddress,
      nonce: fixture.nonce,
      sender: fixture.sender,
      messageHash: fixture.messageHash,
      messageData: data,
      proofState: { kind: "unproven", outputRoot: await findOutputRootPda(program, 1n), proof: Array.from({ length: proofLength }, (_, i) => bytesToHex(new Uint8Array(32).fill(i + 1))) },
      createDestination: null,
      relayRemainingAccounts: await relayRemainingAccounts(program, decoded.transfer, (await import("@solana-program/token")).TOKEN_PROGRAM_ADDRESS),
      existingBuffer: null
    },
    { supportsV1: false, createBufferSigner: () => generateKeyPairSigner(), force }
  );
}

const run = (prep: PreparedClaim, signer: SolanaSigner, rpc: SolanaRpc, isAlreadyClaimed = async () => false) =>
  executeClaim({ prepared: prep, signer, rpc, onProgress: () => undefined, isAlreadyClaimed });

describe("claim execution", () => {
  it("simulates, right-sizes compute, signs and confirms every step in order", async () => {
    const keys = await generateKeyPairSigner();
    const plan = await planFor(keys.address, 20, "split");
    expect(plan.txs.length).toBe(2);
    const { rpc, sent } = fakeRpc();
    const progress: string[] = [];
    const result = await executeClaim({ prepared: await prepared(keys.address, plan), signer: walletFor(keys), rpc, onProgress: (p) => progress.push(`${p.index}:${p.phase}`), isAlreadyClaimed: async () => false });
    expect(result.signatures).toHaveLength(2);
    expect(sent).toHaveLength(2);
    expect(progress).toEqual(["0:simulating", "0:signing", "0:sending", "0:confirming", "0:confirmed", "1:simulating", "1:signing", "1:sending", "1:confirming", "1:confirmed"]);

    // The broadcast transaction carries a compute limit sized from the simulation, not the 1.4M maximum.
    const broadcast = decoder.decode(Uint8Array.from(atob(sent[0]), (c) => c.charCodeAt(0))) as Transaction;
    const instructions = decompileTransactionMessage(getCompiledTransactionMessageDecoder().decode(broadcast.messageBytes)).instructions;
    const limitIx = instructions.find((ix) => ix.data?.[0] === 2)!;
    expect(new DataView(limitIx.data!.buffer, limitIx.data!.byteOffset).getUint32(1, true)).toBe(Math.ceil(50_000 * 1.2) + 3_000);
  });

  it("explains bridge program errors by name and sends nothing", async () => {
    const keys = await generateKeyPairSigner();
    const plan = await planFor(keys.address, 4);
    const { rpc, sent } = fakeRpc({ simulate: () => ({ err: { InstructionError: [3, { Custom: 12501 }] }, logs: [] }) });
    await expect(run(await prepared(keys.address, plan), walletFor(keys), rpc)).rejects.toThrow(/already been claimed.*AlreadyExecuted/);
    expect(sent).toHaveLength(0);
  });

  it("rejects a wallet that drops or alters a bridge instruction", async () => {
    const keys = await generateKeyPairSigner();
    const plan = await planFor(keys.address, 4);
    const { rpc, sent } = fakeRpc();
    const dropRelay = walletFor(keys, (tx) => {
      const message = decompileTransactionMessage(getCompiledTransactionMessageDecoder().decode(tx.messageBytes));
      const kept = { ...message, instructions: message.instructions.filter((ix) => !hasPrefix(ix.data ?? [], INSTRUCTION_DISCRIMINATORS.relayMessage)) };
      return compileTransaction(kept as never) as Transaction;
    });
    await expect(run(await prepared(keys.address, plan), dropRelay, rpc)).rejects.toThrow(/removed or altered/);
    expect(sent).toHaveLength(0);
  });

  it("accepts a wallet that only adds its own instruction", async () => {
    const keys = await generateKeyPairSigner();
    const plan = await planFor(keys.address, 4);
    const { rpc, sent } = fakeRpc();
    const addsIx = walletFor(keys, (tx) => {
      const message = decompileTransactionMessage(getCompiledTransactionMessageDecoder().decode(tx.messageBytes));
      return compileTransaction(appendTransactionMessageInstruction(getSetComputeUnitPriceInstruction({ microLamports: 1n }), message as never) as never) as Transaction;
    });
    await expect(run(await prepared(keys.address, plan), addsIx, rpc)).resolves.toMatchObject({ alreadyClaimed: false });
    expect(sent).toHaveLength(1);
  });

  it("adds the buffer signer's signature after the wallet signs", async () => {
    const keys = await generateKeyPairSigner();
    const plan = await planFor(keys.address, 40, "buffered");
    const { rpc, sent } = fakeRpc();
    await run(await prepared(keys.address, plan), walletFor(keys), rpc);
    const first = decoder.decode(Uint8Array.from(atob(sent[0]), (c) => c.charCodeAt(0))) as Transaction;
    const bufferSigner = plan.txs[0].signers[0];
    for (const signer of [keys.address, bufferSigner.address]) {
      const signature = first.signatures[signer];
      expect(signature).toBeTruthy();
      expect(await verifySignature(await getPublicKeyFromAddress(signer), signature!, first.messageBytes)).toBe(true);
    }
  });

  it("stops early when someone else completes the claim", async () => {
    const keys = await generateKeyPairSigner();
    const plan = await planFor(keys.address, 20, "split");
    const { rpc, sent } = fakeRpc();
    const result = await run(await prepared(keys.address, plan), walletFor(keys), rpc, async () => true);
    expect(result).toEqual({ signatures: [expect.any(String)], alreadyClaimed: true });
    expect(sent).toHaveLength(1);
  });

  it("reports an expired step without claiming success", async () => {
    const keys = await generateKeyPairSigner();
    const plan = await planFor(keys.address, 4);
    const { rpc } = fakeRpc({ status: () => null, blockHeight: 101n });
    await expect(run(await prepared(keys.address, plan), walletFor(keys), rpc)).rejects.toThrow(/did not land before its blockhash expired/);
  });

  it("refuses to run if the connected wallet changed after review", async () => {
    const keys = await generateKeyPairSigner();
    const other = await generateKeyPairSigner();
    const plan = await planFor(keys.address, 4);
    await expect(run(await prepared(keys.address, plan), walletFor(other), fakeRpc().rpc)).rejects.toThrow(/wallet changed/);
  });
});

describe("wallet signature validation", () => {
  it("rejects an invalid signature and a changed fee payer", async () => {
    const keys = await generateKeyPairSigner();
    const other = await generateKeyPairSigner();
    const plan = await planFor(keys.address, 2);
    const tx = buildTransaction({ version: 0, feePayer: keys.address, instructions: plan.txs[0].instructions, blockhash: blockhash("GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi"), lastValidBlockHeight: 1n, computeUnitLimit: 1000, microLamportsPerComputeUnit: 1n });

    const forged = { ...tx, signatures: { ...tx.signatures, [keys.address]: new Uint8Array(64).fill(1) } };
    await expect(validateWalletSignature(new Uint8Array(encoder.encode(forged as never)), tx, keys.address, plan.txs[0].instructions)).rejects.toThrow(/invalid/);

    const otherPayer = buildTransaction({ version: 0, feePayer: other.address, instructions: plan.txs[0].instructions, blockhash: blockhash("GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi"), lastValidBlockHeight: 1n, computeUnitLimit: 1000, microLamportsPerComputeUnit: 1n });
    const signedByOther = await partiallySignTransaction([other.keyPair], otherPayer as never);
    await expect(validateWalletSignature(new Uint8Array(encoder.encode(signedByOther)), tx, keys.address, plan.txs[0].instructions)).rejects.toThrow(/did not sign/);
  });

  it("matches instructions in order, byte for byte", async () => {
    const keys = await generateKeyPairSigner();
    const plan = await planFor(keys.address, 2);
    const ixs = plan.txs[0].instructions;
    expect(containsInOrder(ixs, ixs)).toBe(true);
    expect(containsInOrder([...ixs].reverse(), ixs)).toBe(false);
    expect(containsInOrder(ixs.slice(1), ixs)).toBe(false);
    const changed = { ...ixs[0], data: new Uint8Array(ixs[0].data!).map((byte, i) => (i === 9 ? byte ^ 1 : byte)) };
    expect(containsInOrder([changed, ...ixs.slice(1)], ixs)).toBe(false);
    vi.restoreAllMocks();
  });
});
