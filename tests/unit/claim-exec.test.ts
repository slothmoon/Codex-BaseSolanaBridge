import {
  appendTransactionMessageInstruction,
  blockhash,
  compileTransaction,
  decompileTransactionMessage,
  generateKeyPairSigner,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  getTransactionEncoder,
  partiallySignTransaction,
  type Address,
  type KeyPairSigner,
  type Transaction
} from "@solana/kit";
import { getSetComputeUnitPriceInstruction } from "@solana-program/compute-budget";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { bytesToHex, hexToBytes } from "viem";
import { describe, expect, it } from "vitest";

import { checkWalletSignature, executeClaim, type PreparedClaim, type SolanaSigner } from "../../src/core/claim";
import { planClaim, type ClaimPlan } from "../../src/core/claim-plan";
import type { SolanaRpc } from "../../src/chain/solana";
import { buildTransaction } from "../../src/core/tx";
import { findBridgePda, findOutputRootPda, relayRemainingAccounts } from "../../src/protocol/instructions";
import { decodeBridgeMessage } from "../../src/protocol/message";
import { message, program } from "../helpers";

const encoder = getTransactionEncoder();
const decoder = getTransactionDecoder();
const BLOCKHASH = blockhash("GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi");

/** A fake wallet that signs with a real key, optionally editing the transaction first. */
function walletFor(keys: KeyPairSigner, edit?: (tx: Transaction) => Transaction): SolanaSigner {
  return {
    address: keys.address,
    supportsV1: false,
    async signTransaction(wire) {
      let tx = decoder.decode(wire) as Transaction;
      if (edit) tx = edit(tx);
      return new Uint8Array(encoder.encode(await partiallySignTransaction([keys.keyPair], tx as never)));
    }
  };
}

function fakeRpc(options: { simulate?: () => { err: unknown; logs?: string[] }; landed?: boolean; blockHeight?: bigint; sendFails?: boolean } = {}) {
  const sent: string[] = [];
  const rpc = {
    getLatestBlockhash: () => ({ send: async () => ({ value: { blockhash: BLOCKHASH, lastValidBlockHeight: 100n } }) }),
    simulateTransaction: () => ({ send: async () => ({ value: options.simulate?.() ?? { err: null, logs: [], unitsConsumed: 50_000n, loadedAccountsDataSize: 900_000 } }) }),
    sendTransaction: (wire: string) => ({
      send: async () => {
        sent.push(wire);
        if (options.sendFails) throw new Error("Transaction simulation failed: Blockhash not found");
        return "sig";
      }
    }),
    getSignatureStatuses: () => ({ send: async () => ({ value: [options.landed === false ? null : { err: null, confirmationStatus: "confirmed" }] }) }),
    getBlockHeight: () => ({ send: async () => options.blockHeight ?? 10n })
  };
  return { rpc: rpc as unknown as SolanaRpc, sent };
}

async function planFor(payer: Address, proofLength: number): Promise<ClaimPlan> {
  const fixture = message("spl");
  const data = hexToBytes(fixture.data);
  const decoded = decodeBridgeMessage(data);
  if (decoded.type !== "transfer") throw new Error("fixture must be a transfer");
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
      relayRemainingAccounts: await relayRemainingAccounts(program, decoded.transfer, TOKEN_PROGRAM_ADDRESS)
    },
    { supportsV1: false }
  );
}

const prepared = (payer: Address, plan: ClaimPlan): PreparedClaim => ({
  status: {} as never,
  payer,
  plan,
  cost: { networkFees: 0n, newAccountRent: 0n, required: 0n, balance: 10n ** 9n }
});

const run = (plan: ClaimPlan, signer: SolanaSigner, payer: Address, rpc: SolanaRpc) =>
  executeClaim({ prepared: prepared(payer, plan), signer, rpc, onProgress: () => undefined });

describe("claim execution", () => {
  it("simulates, right-sizes compute, signs and confirms each transaction in order", async () => {
    const keys = await generateKeyPairSigner();
    const plan = await planFor(keys.address, 20);
    expect(plan.strategy).toBe("split");
    const { rpc, sent } = fakeRpc();
    const progress: string[] = [];
    const result = await executeClaim({ prepared: prepared(keys.address, plan), signer: walletFor(keys), rpc, onProgress: (p) => progress.push(`${p.index}:${p.phase}`) });
    expect(result.signatures).toHaveLength(2);
    expect(sent).toHaveLength(2);
    expect(progress).toEqual(["0:simulating", "0:signing", "0:sending", "0:confirming", "0:confirmed", "1:simulating", "1:signing", "1:sending", "1:confirming", "1:confirmed"]);

    // The compute limit comes from the simulation, not the 1.4M maximum.
    const broadcast = decoder.decode(Uint8Array.from(atob(sent[0]), (c) => c.charCodeAt(0))) as Transaction;
    const limit = decompileTransactionMessage(getCompiledTransactionMessageDecoder().decode(broadcast.messageBytes)).instructions.find((ix) => ix.data?.[0] === 2)!;
    expect(new DataView(limit.data!.buffer, limit.data!.byteOffset).getUint32(1, true)).toBe(Math.ceil(50_000 * 1.2) + 3_000);
  });

  it("names bridge program errors and sends nothing when simulation fails", async () => {
    const keys = await generateKeyPairSigner();
    const { rpc, sent } = fakeRpc({ simulate: () => ({ err: { InstructionError: [3, { Custom: 12501 }] }, logs: [] }) });
    await expect(run(await planFor(keys.address, 4), walletFor(keys), keys.address, rpc)).rejects.toThrow(/already been claimed.*AlreadyExecuted/);
    expect(sent).toHaveLength(0);
  });

  it("accepts a wallet that adds its own instruction before signing", async () => {
    const keys = await generateKeyPairSigner();
    const { rpc, sent } = fakeRpc();
    const addsFee = walletFor(keys, (tx) => {
      const message = decompileTransactionMessage(getCompiledTransactionMessageDecoder().decode(tx.messageBytes));
      return compileTransaction(appendTransactionMessageInstruction(getSetComputeUnitPriceInstruction({ microLamports: 1n }), message as never) as never) as Transaction;
    });
    await expect(run(await planFor(keys.address, 4), addsFee, keys.address, rpc)).resolves.toMatchObject({ signatures: [expect.any(String)] });
    expect(sent).toHaveLength(1);
  });

  it("lets the confirmation decide when the RPC errors on a send that still lands", async () => {
    const keys = await generateKeyPairSigner();
    const { rpc, sent } = fakeRpc({ sendFails: true });
    await expect(run(await planFor(keys.address, 4), walletFor(keys), keys.address, rpc)).resolves.toMatchObject({ signatures: [expect.any(String)] });
    expect(sent).toHaveLength(1);
  });

  it("reports an expired transaction without claiming success", async () => {
    const keys = await generateKeyPairSigner();
    const { rpc } = fakeRpc({ landed: false, blockHeight: 101n });
    await expect(run(await planFor(keys.address, 4), walletFor(keys), keys.address, rpc)).rejects.toThrow(/did not land before its blockhash expired/);
  });

  it("refuses to run if the connected wallet changed after review", async () => {
    const keys = await generateKeyPairSigner();
    const other = await generateKeyPairSigner();
    await expect(run(await planFor(keys.address, 4), walletFor(other), keys.address, fakeRpc().rpc)).rejects.toThrow(/wallet changed/);
  });
});

describe("wallet signature check", () => {
  const build = async (payer: Address) =>
    buildTransaction({ version: 0, feePayer: payer, instructions: (await planFor(payer, 2)).txs[0].instructions, blockhash: BLOCKHASH, lastValidBlockHeight: 1n, computeUnitLimit: 1000, microLamportsPerComputeUnit: 1n });

  it("accepts a transaction signed by the connected account", async () => {
    const keys = await generateKeyPairSigner();
    const signed = await partiallySignTransaction([keys.keyPair], (await build(keys.address)) as never);
    await expect(checkWalletSignature(new Uint8Array(encoder.encode(signed)), keys.address)).resolves.toBeTruthy();
  });

  it("rejects a forged signature, a missing signature and a different fee payer", async () => {
    const keys = await generateKeyPairSigner();
    const other = await generateKeyPairSigner();
    const tx = await build(keys.address);
    const forged = { ...tx, signatures: { ...tx.signatures, [keys.address]: new Uint8Array(64).fill(1) } };
    await expect(checkWalletSignature(new Uint8Array(encoder.encode(forged as never)), keys.address)).rejects.toThrow(/did not sign/);
    await expect(checkWalletSignature(new Uint8Array(encoder.encode(tx)), keys.address)).rejects.toThrow(/did not sign/);
    const otherPayer = await partiallySignTransaction([other.keyPair], (await build(other.address)) as never);
    await expect(checkWalletSignature(new Uint8Array(encoder.encode(otherPayer)), keys.address)).rejects.toThrow(/different fee payer/);
  });
});
