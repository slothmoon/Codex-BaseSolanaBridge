import type { AccountMeta, Address, Instruction, KeyPairSigner } from "@solana/kit";
import type { Hex } from "viem";

import { equalBytes, hasPrefix } from "../protocol/bytes";
import { INSTRUCTION_DISCRIMINATORS } from "../protocol/constants";
import {
  appendToProveBufferDataInstruction,
  appendToProveBufferProofInstruction,
  closeProveBufferInstruction,
  initializeProveBufferInstruction,
  proveMessageBufferedInstruction,
  proveMessageInstruction,
  relayMessageInstruction
} from "../protocol/instructions";
import type { ProveBufferAccount } from "../protocol/accounts";
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
  /** A prove buffer this payer started earlier for this message, if any. */
  existingBuffer: { address: Address; account: ProveBufferAccount } | null;
};

export type PlannedTx = {
  label: string;
  instructions: Instruction[];
  /** Extra signers beyond the fee payer (only the new prove buffer). */
  signers: KeyPairSigner[];
};

export type ClaimPlan = {
  version: TxVersion;
  strategy: "single" | "split" | "buffered" | "relay";
  txs: PlannedTx[];
  /** Rent temporarily locked in a prove buffer (refunded when the proof is consumed). */
  bufferSpace: { dataLength: number; proofLength: number } | null;
};

type Item =
  | { type: "fixed"; instructions: Instruction[]; signers?: KeyPairSigner[] }
  | { type: "proof-stream"; nodes: readonly Hex[]; build: (chunk: readonly Hex[]) => Instruction };

/**
 * Packs ordered instructions into as few transactions as fit, splitting the proof stream into the
 * largest chunks that still fit. Order is preserved, which the program relies on.
 */
export function packTransactions(items: Item[], version: TxVersion, payer: Address): PlannedTx[] {
  const txs: PlannedTx[] = [];
  let current: Instruction[] = [];
  let currentSigners: KeyPairSigner[] = [];
  const fits = (instructions: Instruction[]) => fitsInTransaction(version, payer, instructions);
  const flush = () => {
    if (current.length) txs.push({ label: "", instructions: current, signers: currentSigners });
    current = [];
    currentSigners = [];
  };

  for (const item of items) {
    if (item.type === "fixed") {
      if (!fits([...current, ...item.instructions])) {
        flush();
        if (!fits(item.instructions)) throw new Error("A required claim step does not fit in a single Solana transaction.");
      }
      current.push(...item.instructions);
      currentSigners.push(...(item.signers ?? []));
      continue;
    }

    let index = 0;
    while (index < item.nodes.length) {
      let low = 0;
      let high = item.nodes.length - index;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (fits([...current, item.build(item.nodes.slice(index, index + mid))])) low = mid;
        else high = mid - 1;
      }
      if (low === 0) {
        if (current.length === 0) throw new Error("A single proof node does not fit in a Solana transaction.");
        flush();
        continue;
      }
      current.push(item.build(item.nodes.slice(index, index + low)));
      index += low;
    }
  }
  flush();
  return txs.map((tx) => ({ ...tx, label: describe(tx.instructions) }));
}

export type PlanOptions = {
  /** Whether the connected wallet can sign v1 (4096-byte) transactions. */
  supportsV1: boolean;
  /** Creates the throwaway signer for a new prove buffer. Injected for tests. */
  createBufferSigner: () => Promise<KeyPairSigner>;
  /** Forces a strategy (tests only). */
  force?: ClaimPlan["strategy"];
};

export async function planClaim(inputs: ClaimInputs, options: PlanOptions): Promise<ClaimPlan> {
  const version: TxVersion = options.supportsV1 ? 1 : 0;
  const { program, payer, bridge, incomingMessage } = inputs;
  const release: Item[] = [
    ...(inputs.createDestination ? [{ type: "fixed", instructions: [inputs.createDestination] } as Item] : []),
    { type: "fixed", instructions: [relayMessageInstruction({ program, message: incomingMessage, bridge, remainingAccounts: [...inputs.relayRemainingAccounts] })] }
  ];

  // A leftover buffer from an earlier attempt is useless once the message is proven; close it for its rent.
  const cleanup: Item[] =
    inputs.existingBuffer && inputs.proofState.kind === "proven"
      ? [{ type: "fixed", instructions: [closeProveBufferInstruction({ program, owner: payer, buffer: inputs.existingBuffer.address })] }]
      : [];

  if (inputs.proofState.kind === "proven") {
    return { version, strategy: "relay", txs: packTransactions([...cleanup, ...release], version, payer), bufferSpace: null };
  }

  const { outputRoot, proof } = inputs.proofState;
  const prove: Item = {
    type: "fixed",
    instructions: [
      proveMessageInstruction({
        program,
        payer,
        outputRoot,
        message: incomingMessage,
        bridge,
        nonce: inputs.nonce,
        sender: inputs.sender,
        data: inputs.messageData,
        proof,
        messageHash: inputs.messageHash
      })
    ]
  };

  const canResumeBuffer = inputs.existingBuffer && isResumable(inputs.existingBuffer.account, payer, inputs.messageData, proof);
  const stale: Item[] =
    inputs.existingBuffer && !canResumeBuffer
      ? [{ type: "fixed", instructions: [closeProveBufferInstruction({ program, owner: payer, buffer: inputs.existingBuffer.address })] }]
      : [];

  if (!canResumeBuffer && options.force !== "buffered") {
    const allFixed = (items: Item[]) => items.flatMap((item) => (item.type === "fixed" ? item.instructions : []));
    const single = [...stale, prove, ...release];
    if (options.force !== "split" && fitsInTransaction(version, payer, allFixed(single))) {
      return { version, strategy: "single", txs: [{ label: describe(allFixed(single)), instructions: allFixed(single), signers: [] }], bufferSpace: null };
    }
    if (fitsInTransaction(version, payer, allFixed([...stale, prove])) && fitsInTransaction(version, payer, allFixed(release))) {
      return {
        version,
        strategy: "split",
        txs: [
          { label: describe(allFixed([...stale, prove])), instructions: allFixed([...stale, prove]), signers: [] },
          { label: describe(allFixed(release)), instructions: allFixed(release), signers: [] }
        ],
        bufferSpace: null
      };
    }
  }

  // Buffered: stage the message and proof in a buffer account over several transactions.
  let bufferAddress: Address;
  const items: Item[] = [...stale];
  let remainingProof: readonly Hex[] = proof;
  let bufferSpace: ClaimPlan["bufferSpace"] = null;

  if (canResumeBuffer) {
    const existing = inputs.existingBuffer!;
    bufferAddress = existing.address;
    remainingProof = proof.slice(existing.account.proof.length);
    if (existing.account.data.length === 0) {
      items.push({ type: "fixed", instructions: [appendToProveBufferDataInstruction({ program, owner: payer, buffer: bufferAddress, chunk: inputs.messageData })] });
    }
  } else {
    const signer = await options.createBufferSigner();
    bufferAddress = signer.address;
    bufferSpace = { dataLength: inputs.messageData.length, proofLength: proof.length };
    items.push(
      {
        type: "fixed",
        signers: [signer],
        instructions: [
          initializeProveBufferInstruction({ program, payer, bridge, buffer: bufferAddress, maxDataLength: inputs.messageData.length, maxProofLength: proof.length })
        ]
      },
      { type: "fixed", instructions: [appendToProveBufferDataInstruction({ program, owner: payer, buffer: bufferAddress, chunk: inputs.messageData })] }
    );
  }

  items.push(
    { type: "proof-stream", nodes: remainingProof, build: (chunk) => appendToProveBufferProofInstruction({ program, owner: payer, buffer: bufferAddress, proof: chunk }) },
    {
      type: "fixed",
      instructions: [
        proveMessageBufferedInstruction({ program, payer, outputRoot, message: incomingMessage, bridge, buffer: bufferAddress, nonce: inputs.nonce, sender: inputs.sender, messageHash: inputs.messageHash })
      ]
    },
    ...release
  );
  return { version, strategy: "buffered", txs: packTransactions(items, version, payer), bufferSpace };
}

/** A buffer can be resumed only if everything already written matches what this claim needs. */
export function isResumable(buffer: ProveBufferAccount, payer: Address, data: Uint8Array, proof: readonly Hex[]): boolean {
  if (buffer.owner !== payer) return false;
  if (buffer.data.length !== 0 && !equalBytes(buffer.data, data)) return false;
  if (buffer.proof.length > proof.length) return false;
  return buffer.proof.every((node, index) => node.toLowerCase() === proof[index].toLowerCase());
}

function describe(instructions: Instruction[]): string {
  const uses = (...names: (keyof typeof INSTRUCTION_DISCRIMINATORS)[]) =>
    instructions.some((ix) => names.some((name) => hasPrefix(ix.data ?? [], INSTRUCTION_DISCRIMINATORS[name])));
  const relays = uses("relayMessage");
  const proves = uses("proveMessage", "proveMessageBuffered");
  const uploads = uses("initializeProveBuffer", "appendToProveBufferData", "appendToProveBufferProof");
  if (proves && relays) return uploads ? "Finish the proof and release funds" : "Prove the message and release funds";
  if (relays) return "Release funds on Solana";
  if (proves) return uploads ? "Finish uploading the proof and prove the message" : "Prove the message on Solana";
  if (uploads) return "Upload the proof to Solana";
  return "Close a leftover proof buffer";
}
