import { address, generateKeyPairSigner, type Instruction } from "@solana/kit";
import { findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstruction, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { createNoopSigner } from "@solana/kit";
import { bytesToHex, hexToBytes, type Hex } from "viem";
import { describe, expect, it } from "vitest";

import { isResumable, planClaim, type ClaimInputs, type ClaimPlan } from "../../src/core/claim-plan";
import { measureTransaction, SIZE_LIMIT } from "../../src/core/tx";
import { hasPrefix, ByteReader } from "../../src/protocol/bytes";
import { INSTRUCTION_DISCRIMINATORS } from "../../src/protocol/constants";
import { findBridgePda, findOutputRootPda, relayRemainingAccounts } from "../../src/protocol/instructions";
import { decodeBridgeMessage } from "../../src/protocol/message";
import { mainnet, message, payer, program } from "../helpers";

const node = (i: number): Hex => bytesToHex(new Uint8Array(32).fill((i % 250) + 1));
const proofOf = (length: number) => Array.from({ length }, (_, i) => node(i));
const is = (ix: Instruction, name: keyof typeof INSTRUCTION_DISCRIMINATORS) => hasPrefix(ix.data ?? [], INSTRUCTION_DISCRIMINATORS[name]);

async function inputs(overrides: Partial<ClaimInputs> & { proofLength?: number; withAta?: boolean } = {}): Promise<ClaimInputs> {
  const fixture = message("spl");
  const data = hexToBytes(fixture.data);
  const decoded = decodeBridgeMessage(data);
  if (decoded.type !== "transfer" || decoded.transfer.kind !== "spl") throw new Error("fixture must be an SPL transfer");
  const mint = decoded.transfer.mint;
  const [ata] = await findAssociatedTokenPda({ owner: payer, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  return {
    program,
    payer,
    bridge: await findBridgePda(program),
    incomingMessage: fixture.incomingAddress,
    nonce: fixture.nonce,
    sender: fixture.sender,
    messageHash: fixture.messageHash,
    messageData: data,
    proofState: { kind: "unproven", outputRoot: await findOutputRootPda(program, BigInt(mainnet.outputRoot.block)), proof: proofOf(overrides.proofLength ?? 8) },
    createDestination:
      overrides.withAta === false
        ? null
        : getCreateAssociatedTokenIdempotentInstruction({ payer: createNoopSigner(payer), ata, owner: payer, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS }),
    relayRemainingAccounts: await relayRemainingAccounts(program, decoded.transfer, TOKEN_PROGRAM_ADDRESS),
    existingBuffer: null,
    ...overrides
  };
}

const newSigner = () => generateKeyPairSigner();

/** Asserts every structural invariant a valid plan must satisfy. */
function checkPlan(plan: ClaimPlan, proof: Hex[]): void {
  const all = plan.txs.flatMap((tx) => tx.instructions);
  for (const tx of plan.txs) {
    expect(measureTransaction(plan.version, payer, tx.instructions)).toBeLessThanOrEqual(SIZE_LIMIT[plan.version]);
    // Only the transaction that creates the buffer carries the extra signer.
    expect(tx.signers.length).toBe(tx.instructions.some((ix) => is(ix, "initializeProveBuffer")) ? 1 : 0);
  }
  const position = (name: keyof typeof INSTRUCTION_DISCRIMINATORS) => all.findIndex((ix) => is(ix, name));
  const relay = position("relayMessage");
  expect(relay).toBe(all.length - 1);
  if (plan.strategy === "buffered") {
    const init = position("initializeProveBuffer");
    const data = position("appendToProveBufferData");
    const proveBuffered = position("proveMessageBuffered");
    expect(init).toBeLessThan(data);
    expect(data).toBeLessThan(proveBuffered);
    expect(proveBuffered).toBeLessThan(relay);
    // The uploaded chunks, in order, are exactly the proof.
    const uploaded: Hex[] = [];
    for (const ix of all.filter((item) => is(item, "appendToProveBufferProof"))) {
      const reader = new ByteReader(ix.data!.subarray(8));
      const count = reader.u32();
      for (let i = 0; i < count; i++) uploaded.push(bytesToHex(reader.bytes_(32)));
    }
    expect(uploaded).toEqual(proof);
    expect(all.some((ix) => is(ix, "proveMessage"))).toBe(false);
  } else if (plan.strategy !== "relay") {
    expect(position("proveMessage")).toBeLessThan(relay);
  }
}

describe("claim planning", () => {
  it("always produces a valid plan for proofs of 0–40 nodes with a legacy-size (v0) wallet", async () => {
    const seen = new Map<string, number[]>();
    for (let length = 0; length <= 40; length++) {
      const proof = proofOf(length);
      const plan = await planClaim(await inputs({ proofLength: length }), { supportsV1: false, createBufferSigner: newSigner });
      checkPlan(plan, proof);
      seen.set(plan.strategy, [...(seen.get(plan.strategy) ?? []), length]);
    }
    // Small proofs fit in one transaction; mid-size proofs split like the official relayer; large ones use the buffer.
    expect(seen.get("single")?.[0]).toBe(0);
    expect(seen.get("split")?.length).toBeGreaterThan(0);
    expect(seen.get("buffered")?.at(-1)).toBe(40);
    expect(Math.max(...seen.get("single")!)).toBeLessThan(Math.min(...seen.get("split")!));
    expect(Math.max(...seen.get("split")!)).toBeLessThan(Math.min(...seen.get("buffered")!));
  });

  it("covers the audit's failing case: 18+ node proofs no longer break the claim", async () => {
    for (const length of [17, 18, 22, 24]) {
      const plan = await planClaim(await inputs({ proofLength: length }), { supportsV1: false, createBufferSigner: newSigner });
      checkPlan(plan, proofOf(length));
    }
  });

  it("uses a single large (v1) transaction whenever the wallet supports it", async () => {
    for (const length of [0, 18, 40, 90]) {
      const plan = await planClaim(await inputs({ proofLength: length }), { supportsV1: true, createBufferSigner: newSigner });
      expect(plan).toMatchObject({ version: 1, strategy: "single" });
      checkPlan(plan, proofOf(length));
    }
  });

  it("buffers even huge proofs in v0 across several transactions", async () => {
    const plan = await planClaim(await inputs({ proofLength: 64 }), { supportsV1: false, createBufferSigner: newSigner });
    expect(plan.strategy).toBe("buffered");
    expect(plan.txs.length).toBeGreaterThanOrEqual(3);
    expect(plan.bufferSpace).toEqual({ dataLength: 98, proofLength: 64 });
    checkPlan(plan, proofOf(64));
  });

  it("only relays once the message is proven, and closes a leftover buffer for its rent", async () => {
    const buffer = address("5ZiE3vAkrdXBgyFL7KqG3RoEGBws4CjRcXVbABDLZTgE");
    const plan = await planClaim(
      await inputs({ proofState: { kind: "proven" }, existingBuffer: { address: buffer, account: { owner: payer, data: new Uint8Array(), proof: [] } } }),
      { supportsV1: false, createBufferSigner: newSigner }
    );
    expect(plan.strategy).toBe("relay");
    const all = plan.txs.flatMap((tx) => tx.instructions);
    expect(is(all[0], "closeProveBuffer")).toBe(true);
    expect(all.some((ix) => is(ix, "proveMessage") || is(ix, "proveMessageBuffered"))).toBe(false);
  });

  it("resumes a matching half-written buffer without re-uploading", async () => {
    const proof = proofOf(30);
    const base = await inputs({ proofLength: 30 });
    const buffer = address("5ZiE3vAkrdXBgyFL7KqG3RoEGBws4CjRcXVbABDLZTgE");
    const plan = await planClaim(
      { ...base, existingBuffer: { address: buffer, account: { owner: payer, data: base.messageData, proof: proof.slice(0, 12) } } },
      { supportsV1: false, createBufferSigner: () => Promise.reject(new Error("must not create a new buffer")) }
    );
    const all = plan.txs.flatMap((tx) => tx.instructions);
    expect(plan.strategy).toBe("buffered");
    expect(all.some((ix) => is(ix, "initializeProveBuffer") || is(ix, "appendToProveBufferData"))).toBe(false);
    const uploaded = all.filter((ix) => is(ix, "appendToProveBufferProof")).reduce((sum, ix) => sum + new DataView(ix.data!.buffer, ix.data!.byteOffset).getUint32(8, true), 0);
    expect(uploaded).toBe(18);
  });

  it("replaces a buffer that does not match this claim", async () => {
    const base = await inputs({ proofLength: 10 });
    const stale = { address: address("5ZiE3vAkrdXBgyFL7KqG3RoEGBws4CjRcXVbABDLZTgE"), account: { owner: payer, data: new Uint8Array([9]), proof: [] } };
    const plan = await planClaim({ ...base, existingBuffer: stale }, { supportsV1: false, createBufferSigner: newSigner });
    const all = plan.txs.flatMap((tx) => tx.instructions);
    expect(is(all[0], "closeProveBuffer")).toBe(true);
    expect(all.at(-1) && is(all.at(-1)!, "relayMessage")).toBe(true);
  });

  it("decides resumability conservatively", () => {
    const proof = proofOf(4);
    const data = new Uint8Array([1, 2, 3]);
    expect(isResumable({ owner: payer, data, proof: proof.slice(0, 2) }, payer, data, proof)).toBe(true);
    expect(isResumable({ owner: payer, data: new Uint8Array(), proof: [] }, payer, data, proof)).toBe(true);
    expect(isResumable({ owner: program, data, proof: [] }, payer, data, proof)).toBe(false);
    expect(isResumable({ owner: payer, data: new Uint8Array([1]), proof: [] }, payer, data, proof)).toBe(false);
    expect(isResumable({ owner: payer, data, proof: [proof[1]] }, payer, data, proof)).toBe(false);
    expect(isResumable({ owner: payer, data, proof: proofOf(5) }, payer, data, proof)).toBe(false);
  });
});
