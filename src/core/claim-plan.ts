import type { AccountMeta, Address, Instruction } from "@solana/kit";
import type { Hex } from "viem";

import { proveMessageInstruction, relayMessageInstruction } from "../protocol/instructions";
import { UserFacingError } from "./errors";
import { fitsInTransaction, type TxVersion } from "./tx";

export type ProofState =
  /** No proof account yet (or only lamports sent to its address). */
  | { kind: "unproven"; outputRoot: Address; proof: readonly Hex[] }
  /** `prove_message` already ran; only the relay remains. */
  | { kind: "proven" };

export type ClaimInputs = {
  program: Address;
  payer: Address;
  bridge: Address;
  incomingMessage: Address;
  nonce: bigint;
  sender: Hex;
  messageHash: Hex;
  messageData: Uint8Array;
  proofState: ProofState;
  /** Instruction that creates the destination token account, when it does not exist yet. */
  createDestination: Instruction | null;
  relayRemainingAccounts: AccountMeta[];
};

export type PlannedTx = { label: string; instructions: Instruction[] };

export type ClaimPlan = {
  version: TxVersion;
  strategy: "single" | "split" | "relay";
  txs: PlannedTx[];
};

/**
 * Chooses how to submit a claim. Everything uses standard v0 transactions — one transaction when it
 * fits, otherwise "prove" then "release", the pattern used by real mainnet claims. Only when a proof
 * is too large even for that (22+ nodes, which only happens for claims made long after the burn on a
 * busy bridge) does it fall back to one large v1 transaction, if the wallet supports them.
 */
export function planClaim(inputs: ClaimInputs, options: { supportsV1: boolean }): ClaimPlan {
  const { program, payer, bridge, incomingMessage } = inputs;
  const release = [
    ...(inputs.createDestination ? [inputs.createDestination] : []),
    relayMessageInstruction({ program, message: incomingMessage, bridge, remainingAccounts: inputs.relayRemainingAccounts })
  ];

  if (inputs.proofState.kind === "proven") {
    return { version: 0, strategy: "relay", txs: [{ label: "Release funds on Solana", instructions: release }] };
  }

  const prove = proveMessageInstruction({
    program,
    payer,
    outputRoot: inputs.proofState.outputRoot,
    message: incomingMessage,
    bridge,
    nonce: inputs.nonce,
    sender: inputs.sender,
    data: inputs.messageData,
    proof: inputs.proofState.proof,
    messageHash: inputs.messageHash
  });
  const single = [prove, ...release];

  if (fitsInTransaction(0, payer, single)) {
    return { version: 0, strategy: "single", txs: [{ label: "Prove the message and release funds", instructions: single }] };
  }
  if (fitsInTransaction(0, payer, [prove]) && fitsInTransaction(0, payer, release)) {
    return {
      version: 0,
      strategy: "split",
      txs: [
        { label: "Prove the message on Solana", instructions: [prove] },
        { label: "Release funds on Solana", instructions: release }
      ]
    };
  }
  if (options.supportsV1 && fitsInTransaction(1, payer, single)) {
    return { version: 1, strategy: "single", txs: [{ label: "Prove the message and release funds", instructions: single }] };
  }
  throw new UserFacingError("Connect a Solana wallet that supports large (v1) transactions to claim.");
}
