import { createNoopSigner } from "@solana/kit";
import { findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstruction, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { bytesToHex, hexToBytes, type Hex } from "viem";
import { describe, expect, it } from "vitest";

import { planClaim, type ClaimInputs, type ClaimPlan } from "../../src/core/claim-plan";
import { measureTransaction, SIZE_LIMIT } from "../../src/core/tx";
import { hasPrefix } from "../../src/protocol/bytes";
import { INSTRUCTION_DISCRIMINATORS } from "../../src/protocol/constants";
import { findBridgePda, findOutputRootPda, relayRemainingAccounts } from "../../src/protocol/instructions";
import { decodeBridgeMessage } from "../../src/protocol/message";
import { mainnet, message, payer, program } from "../helpers";

const proofOf = (length: number): Hex[] => Array.from({ length }, (_, i) => bytesToHex(new Uint8Array(32).fill((i % 250) + 1)));

async function inputs(proofLength: number | "proven", withAta = true): Promise<ClaimInputs> {
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
    proofState: proofLength === "proven" ? { kind: "proven" } : { kind: "unproven", outputRoot: await findOutputRootPda(program, BigInt(mainnet.outputRoot.block)), proof: proofOf(proofLength) },
    createDestination: withAta ? getCreateAssociatedTokenIdempotentInstruction({ payer: createNoopSigner(payer), ata, owner: payer, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS }) : null,
    relayRemainingAccounts: await relayRemainingAccounts(program, decoded.transfer, TOKEN_PROGRAM_ADDRESS)
  };
}

const is = (plan: ClaimPlan, index: number, name: keyof typeof INSTRUCTION_DISCRIMINATORS) =>
  plan.txs.flatMap((tx) => tx.instructions).some((ix, i) => i === index && hasPrefix(ix.data ?? [], INSTRUCTION_DISCRIMINATORS[name]));

function checkPlan(plan: ClaimPlan): void {
  for (const tx of plan.txs) expect(measureTransaction(plan.version, payer, tx.instructions)).toBeLessThanOrEqual(SIZE_LIMIT[plan.version]);
  const all = plan.txs.flatMap((tx) => tx.instructions);
  expect(hasPrefix(all.at(-1)!.data ?? [], INSTRUCTION_DISCRIMINATORS.relayMessage)).toBe(true); // release is always last
  if (plan.strategy !== "relay") expect(is(plan, 0, "proveMessage")).toBe(true); // prove is always first
}

describe("claim planning", () => {
  it("uses standard v0 transactions for every realistic proof: one transaction, then prove/release", async () => {
    const seen: Record<string, number[]> = {};
    for (let length = 0; length <= 21; length++) {
      const plan = planClaim(await inputs(length), { supportsV1: true }); // v1 support must not change the default
      checkPlan(plan);
      expect(plan.version).toBe(0);
      (seen[plan.strategy] ??= []).push(length);
    }
    expect(seen.single[0]).toBe(0);
    expect(Math.max(...seen.single)).toBeLessThan(Math.min(...seen.split));
    expect(seen.split.at(-1)).toBe(21);
  });

  it("covers the audit's failing case: 18-node proofs no longer break the claim", async () => {
    for (const length of [17, 18, 21]) checkPlan(planClaim(await inputs(length), { supportsV1: false }));
  });

  it("falls back to one v1 transaction only for proofs too large for v0", async () => {
    for (const length of [22, 24, 40]) {
      const plan = planClaim(await inputs(length), { supportsV1: true });
      expect(plan).toMatchObject({ version: 1, strategy: "single" });
      checkPlan(plan);
    }
  });

  it("explains, instead of failing silently, when the proof is too large and the wallet cannot sign v1", async () => {
    await expect(inputs(24).then((value) => planClaim(value, { supportsV1: false }))).rejects.toThrow("Connect a Solana wallet that supports large (v1) transactions to claim.");
  });

  it("only releases once the message is proven", async () => {
    const plan = planClaim(await inputs("proven"), { supportsV1: false });
    expect(plan).toMatchObject({ version: 0, strategy: "relay" });
    expect(plan.txs).toHaveLength(1);
    checkPlan(plan);
  });

  it("creates the destination account only when asked", async () => {
    const withAta = planClaim(await inputs(4, true), { supportsV1: false });
    const without = planClaim(await inputs(4, false), { supportsV1: false });
    expect(withAta.txs[0].instructions).toHaveLength(3);
    expect(without.txs[0].instructions).toHaveLength(2);
  });
});
