import {
  createNoopSigner,
  decompileTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getPublicKeyFromAddress,
  getSignatureFromTransaction,
  getTransactionDecoder,
  getTransactionEncoder,
  partiallySignTransaction,
  verifySignature,
  type Address,
  type Instruction,
  type Transaction
} from "@solana/kit";
import { findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstruction } from "@solana-program/token";
import { hexToBytes, type PublicClient } from "viem";

import { NETWORK } from "../config";
import { generateProof } from "../chain/base";
import { fetchAccounts, fetchMinimumRent, sendWireTransaction, waitForSignature, type SolanaRpc } from "../chain/solana";
import { decodeMint, decodeOutputRoot, decodeProveBuffer, decodeTokenAccount, incomingMessageSpace, proveBufferSpace } from "../protocol/accounts";
import { hasPrefix } from "../protocol/bytes";
import { INSTRUCTION_DISCRIMINATORS, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from "../protocol/constants";
import { findOutputRootPda, findSolVaultPda, findTokenVaultPda, relayRemainingAccounts } from "../protocol/instructions";
import { verifyMmrProof } from "../protocol/mmr";
import { assessDestination, assessMint, assessVault, associatedAccountSize, type Finding } from "../protocol/token2022";
import { planClaim, type ClaimPlan, type ProofState } from "./claim-plan";
import { explainTransactionError, UserFacingError } from "./errors";
import { estimatePriorityFee, LAMPORTS_PER_SIGNATURE, priorityFeeLamports } from "./fees";
import type { TrackedTransfer } from "./status";
import { clearBufferRecord, loadBufferRecord, saveBufferRecord } from "./storage";
import { buildTransaction, MAX_COMPUTE_UNITS, MAX_LOADED_ACCOUNTS_DATA } from "./tx";

/** What the app needs from a connected Solana wallet. */
export type SolanaSigner = {
  address: Address;
  supportsV1: boolean;
  /** Signs (does not send) a wire transaction and returns the signed wire bytes. */
  signTransaction(wire: Uint8Array): Promise<Uint8Array>;
};

export type ClaimCost = {
  networkFees: bigint;
  newAccountRent: bigint;
  /** Held in the prove buffer during the claim and refunded when the proof is consumed. */
  refundableRent: bigint;
  /** Minimum balance the wallet needs at the start. */
  required: bigint;
  balance: bigint;
};

export type PreparedClaim = {
  status: TrackedTransfer;
  payer: Address;
  plan: ClaimPlan;
  cost: ClaimCost;
  priorityFee: bigint;
  findings: Finding[];
  destination: { address: Address; created: boolean };
  rootBlock: bigint | null;
};

const ROUGH_UNITS_PER_TX = 200_000;

export async function prepareClaim(input: {
  status: TrackedTransfer & { state: "ready" | "proven" };
  payer: Address;
  supportsV1: boolean;
  rpc: SolanaRpc;
  archive: PublicClient;
}): Promise<PreparedClaim> {
  const { status, payer, rpc } = input;
  const program = NETWORK.solana.bridgeProgram;
  const transfer = status.transfer;
  const findings: Finding[] = [];
  const messageData = hexToBytes(status.event.data);

  // ---- Proof (skipped when already proven) ----------------------------------------------------
  let proofState: ProofState = { kind: "proven" };
  let rootBlock: bigint | null = null;
  let existingBuffer: { address: Address; account: ReturnType<typeof decodeProveBuffer> } | null = null;
  let incomingLamports = 0n;

  const record = loadBufferRecord(status.event.messageHash);
  if (record && record.payer === payer) {
    const [bufferAccount] = await fetchAccounts(rpc, [record.address]);
    if (bufferAccount && bufferAccount.owner === program) {
      existingBuffer = { address: record.address, account: decodeProveBuffer(bufferAccount.data) };
    } else {
      clearBufferRecord(status.event.messageHash);
    }
  }

  if (status.state === "ready") {
    // Resume against the root a half-written buffer was built for; otherwise use the latest root.
    rootBlock = existingBuffer && record ? BigInt(record.rootBlock) : status.bridge.baseBlockNumber;
    const outputRoot = await findOutputRootPda(program, rootBlock);
    const [outputRootAccount, incomingAccount] = await fetchAccounts(rpc, [outputRoot, status.incomingMessage]);
    if (!outputRootAccount || outputRootAccount.owner !== program) throw new UserFacingError("The Solana output root for this claim was not found. Refresh the status and try again.");
    const root = decodeOutputRoot(outputRootAccount.data);
    if (incomingAccount?.owner === SYSTEM_PROGRAM) incomingLamports = incomingAccount.lamports;

    let proof;
    try {
      proof = await generateProof(input.archive, status.event.nonce, rootBlock);
    } catch (error) {
      throw new UserFacingError(
        "Could not generate the proof on Base. The Base RPC must support historical calls; try again in a moment.",
        String((error as Error)?.message ?? error)
      );
    }
    const valid = verifyMmrProof({ root: root.root, leafHash: status.event.messageHash, leafIndex: status.event.nonce, proof, totalLeafCount: root.totalLeafCount });
    if (!valid) throw new UserFacingError("The proof from Base does not match the output root on Solana, so nothing was sent. Refresh and try again.");
    proofState = { kind: "unproven", outputRoot, proof };
  }

  // ---- Destination and asset checks ----------------------------------------------------------
  let createDestination: Instruction | null = null;
  let destinationRent = 0n;
  let tokenProgram: Address | null = null;

  if (transfer.kind === "sol") {
    const [solVault, recipient] = await fetchAccounts(rpc, [await findSolVaultPda(program), transfer.to]);
    const rentFloor = await fetchMinimumRent(rpc, 0);
    if (!recipient && transfer.amount < rentFloor) {
      throw new UserFacingError(`The recipient wallet is empty and ${formatLamports(transfer.amount)} SOL is below Solana's minimum account balance (${formatLamports(rentFloor)} SOL), so this claim cannot succeed until the recipient wallet holds some SOL.`);
    }
    if (!solVault || solVault.lamports < transfer.amount) findings.push({ level: "block", code: "vault-balance", message: "The bridge's SOL vault does not currently hold enough SOL for this claim." });
  } else {
    const [mintAccount, destinationAccount] = await fetchAccounts(rpc, [transfer.mint, transfer.to]);
    if (!mintAccount) throw new UserFacingError("The Solana mint no longer exists.");
    tokenProgram = mintAccount.owner;
    if (tokenProgram !== TOKEN_PROGRAM && tokenProgram !== TOKEN_2022_PROGRAM) throw new UserFacingError("The Solana mint uses an unsupported token program.");
    if (transfer.kind === "wrapped" && tokenProgram !== TOKEN_2022_PROGRAM) throw new UserFacingError("Wrapped-token mints must be Token-2022.");
    const mint = decodeMint(mintAccount.data);
    if (transfer.kind === "spl") findings.push(...assessMint(mint, tokenProgram === TOKEN_2022_PROGRAM));

    if (transfer.kind === "spl") {
      const vaultAddress = await findTokenVaultPda(program, transfer.mint, transfer.baseToken);
      const [vault] = await fetchAccounts(rpc, [vaultAddress]);
      if (!vault) findings.push({ level: "block", code: "vault-missing", message: "The bridge vault for this token does not exist." });
      else {
        const decoded = decodeTokenAccount(vault.data);
        findings.push(...assessVault(decoded));
        if (decoded.amount < transfer.amount) findings.push({ level: "block", code: "vault-balance", message: "The bridge vault does not currently hold enough of this token for the claim." });
      }
    }

    if (destinationAccount) {
      const destination = decodeTokenAccount(destinationAccount.data);
      if (destination.mint !== transfer.mint) throw new UserFacingError("The destination token account is for a different mint.");
      findings.push(...assessDestination(destination));
    } else {
      const [payerAta] = await findAssociatedTokenPda({ owner: payer, mint: transfer.mint, tokenProgram });
      if (payerAta !== transfer.to) {
        throw new UserFacingError(
          `The destination token account ${transfer.to} does not exist yet, and it is not your wallet's token account, so it can only be created by its owner. Connect the recipient's Solana wallet to claim.`
        );
      }
      createDestination = getCreateAssociatedTokenIdempotentInstruction({ payer: createNoopSigner(payer), ata: payerAta, owner: payer, mint: transfer.mint, tokenProgram });
      destinationRent = await fetchMinimumRent(rpc, associatedAccountSize(mint.extensions, tokenProgram === TOKEN_2022_PROGRAM));
    }
  }

  const blockers = findings.filter((finding) => finding.level === "block");
  if (blockers.length) throw new UserFacingError(blockers.map((finding) => finding.message).join(" "));

  // ---- Plan ----------------------------------------------------------------------------------
  const plan = await planClaim(
    {
      program,
      payer,
      bridge: status.bridgePda,
      incomingMessage: status.incomingMessage,
      nonce: status.event.nonce,
      sender: status.event.sender,
      messageHash: status.event.messageHash,
      messageData,
      proofState,
      createDestination,
      relayRemainingAccounts: await relayRemainingAccounts(program, transfer, tokenProgram),
      existingBuffer
    },
    { supportsV1: input.supportsV1, createBufferSigner: () => generateKeyPairSigner() }
  );

  // ---- Cost ----------------------------------------------------------------------------------
  const writable = [status.incomingMessage, transfer.to];
  const priorityFee = await estimatePriorityFee(rpc, writable);
  const signatures = plan.txs.reduce((sum, tx) => sum + 1 + tx.signers.length, 0);
  const networkFees = BigInt(signatures) * LAMPORTS_PER_SIGNATURE + BigInt(plan.txs.length) * priorityFeeLamports(ROUGH_UNITS_PER_TX, priorityFee);
  let newAccountRent = destinationRent;
  if (proofState.kind === "unproven") {
    const proofRent = await fetchMinimumRent(rpc, incomingMessageSpace(messageData.length));
    newAccountRent += proofRent > incomingLamports ? proofRent - incomingLamports : 0n;
  }
  const refundableRent = plan.bufferSpace ? await fetchMinimumRent(rpc, proveBufferSpace(plan.bufferSpace.dataLength, plan.bufferSpace.proofLength)) : 0n;
  const { value: balance } = await rpc.getBalance(payer, { commitment: "confirmed" }).send();

  return {
    status,
    payer,
    plan,
    priorityFee,
    findings,
    rootBlock,
    destination: { address: transfer.to, created: Boolean(createDestination) },
    cost: { networkFees, newAccountRent, refundableRent, required: networkFees + newAccountRent + refundableRent, balance: BigInt(balance) }
  };
}

export function formatLamports(value: bigint): string {
  const whole = value / 1_000_000_000n;
  const fraction = (value % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

// ---------------------------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------------------------

export type ClaimProgress = {
  index: number;
  total: number;
  label: string;
  phase: "simulating" | "signing" | "sending" | "confirming" | "confirmed";
  signature?: string;
};

export type ClaimResult = { signatures: string[]; alreadyClaimed: boolean };

export async function executeClaim(input: {
  prepared: PreparedClaim;
  signer: SolanaSigner;
  rpc: SolanaRpc;
  onProgress: (progress: ClaimProgress) => void;
  isAlreadyClaimed: () => Promise<boolean>;
  signal?: AbortSignal;
}): Promise<ClaimResult> {
  const { prepared, signer, rpc } = input;
  if (signer.address !== prepared.payer) throw new UserFacingError("The connected Solana wallet changed. Review the claim again.");
  const { plan } = prepared;
  const signatures: string[] = [];
  const messageHash = prepared.status.event.messageHash;

  for (const [index, tx] of plan.txs.entries()) {
    const report = (phase: ClaimProgress["phase"], signature?: string) =>
      input.onProgress({ index, total: plan.txs.length, label: tx.label, phase, signature });

    if (index > 0 && (await input.isAlreadyClaimed())) return { signatures, alreadyClaimed: true };

    report("simulating");
    const { value: latest } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
    const base = {
      version: plan.version,
      feePayer: prepared.payer,
      instructions: tx.instructions,
      blockhash: latest.blockhash,
      lastValidBlockHeight: BigInt(latest.lastValidBlockHeight),
      microLamportsPerComputeUnit: prepared.priorityFee
    };

    const probe = buildTransaction({ ...base, computeUnitLimit: MAX_COMPUTE_UNITS, loadedAccountsDataSizeLimit: MAX_LOADED_ACCOUNTS_DATA });
    const simulation = await rpc
      .simulateTransaction(getBase64EncodedWireTransaction(probe), {
        encoding: "base64",
        sigVerify: false,
        replaceRecentBlockhash: false,
        commitment: "confirmed"
      })
      .send();
    if (simulation.value.err) {
      throw new UserFacingError(
        `Simulation failed, so nothing was sent: ${explainTransactionError(simulation.value.err, instructionPrograms(probe), simulation.value.logs)}`,
        (simulation.value.logs ?? []).join("\n")
      );
    }
    const units = Number(simulation.value.unitsConsumed ?? BigInt(MAX_COMPUTE_UNITS));
    const loaded = simulation.value.loadedAccountsDataSize;
    const transaction = buildTransaction({
      ...base,
      computeUnitLimit: Math.min(MAX_COMPUTE_UNITS, Math.ceil(units * 1.2) + 3_000),
      loadedAccountsDataSizeLimit: loaded ? Math.min(MAX_LOADED_ACCOUNTS_DATA, Math.ceil(Number(loaded) * 1.25) + 64 * 1024) : MAX_LOADED_ACCOUNTS_DATA
    });

    report("signing");
    const unsignedWire = new Uint8Array(getTransactionEncoder().encode(transaction));
    const signedWire = await signer.signTransaction(unsignedWire);
    let signed = await validateWalletSignature(signedWire, transaction, prepared.payer, tx.instructions);
    if (tx.signers.length) signed = await partiallySignTransaction(tx.signers.map((extra) => extra.keyPair), signed);

    const signature = getSignatureFromTransaction(signed);
    const wire = getBase64EncodedWireTransaction(signed);
    report("sending", signature);
    try {
      await sendWireTransaction(rpc, wire, true);
    } catch (error) {
      const text = String((error as Error)?.message ?? error);
      if (!/already been processed|AlreadyProcessed/i.test(text)) {
        const context = (error as { context?: { __serverMessage?: string; logs?: string[]; err?: unknown } }).context;
        throw new UserFacingError(
          `Solana rejected the transaction before it was sent: ${context?.err ? explainTransactionError(context.err, instructionPrograms(transaction), context.logs) : text}`,
          (context?.logs ?? []).join("\n")
        );
      }
    }

    // Remember a new buffer as soon as it might exist, so an interrupted claim can resume or reclaim its rent.
    const createsBuffer = tx.signers.length > 0;
    if (createsBuffer && prepared.rootBlock !== null) {
      saveBufferRecord(messageHash, { address: tx.signers[0].address, rootBlock: prepared.rootBlock.toString(), payer: prepared.payer });
    }

    report("confirming", signature);
    const outcome = await waitForSignature(rpc, signature, BigInt(latest.lastValidBlockHeight), {
      signal: input.signal,
      resend: () => sendWireTransaction(rpc, wire, false)
    });
    if (outcome.status === "expired") {
      throw new UserFacingError(`"${tx.label}" did not land before its blockhash expired. Nothing was lost — click Claim again to continue where it stopped.`);
    }
    if (outcome.status === "failed") {
      throw new UserFacingError(`"${tx.label}" failed on Solana: ${explainTransactionError(outcome.error, instructionPrograms(transaction))} Click Claim again to retry.`);
    }
    signatures.push(signature);
    report("confirmed", signature);
    if (tx.instructions.some((ix) => hasPrefix(ix.data ?? [], INSTRUCTION_DISCRIMINATORS.proveMessageBuffered))) clearBufferRecord(messageHash);
  }
  clearBufferRecord(messageHash);
  return { signatures, alreadyClaimed: false };
}

/** Program of each compiled instruction, so an `InstructionError` index can be attributed exactly. */
export function instructionPrograms(transaction: Transaction): Address[] {
  try {
    const message = decompileTransactionMessage(getCompiledTransactionMessageDecoder().decode(transaction.messageBytes));
    return (message.instructions as readonly { programAddress: Address }[]).map((ix) => ix.programAddress);
  } catch {
    return [];
  }
}

/**
 * Wallets may add their own instructions (e.g. priority fees) before signing. Accept that only if
 * the fee payer is unchanged, the payer's signature is valid, and every instruction we asked for
 * is still present, in order and byte-for-byte.
 */
export async function validateWalletSignature(signedWire: Uint8Array, original: Transaction, payer: Address, expected: readonly Instruction[]): Promise<Transaction> {
  let signed: Transaction;
  try {
    signed = getTransactionDecoder().decode(signedWire) as Transaction;
  } catch {
    throw new UserFacingError("The wallet returned a transaction that could not be decoded. Nothing was sent.");
  }
  const signature = signed.signatures[payer];
  if (!signature) throw new UserFacingError("The wallet did not sign with the connected account. Nothing was sent.");
  const valid = await verifySignature(await getPublicKeyFromAddress(payer), signature, signed.messageBytes);
  if (!valid) throw new UserFacingError("The wallet's signature is invalid. Nothing was sent.");

  const unchanged = signed.messageBytes.length === original.messageBytes.length && signed.messageBytes.every((byte, i) => byte === original.messageBytes[i]);
  if (unchanged) return signed;

  let instructions: readonly Instruction[];
  try {
    const compiled = getCompiledTransactionMessageDecoder().decode(signed.messageBytes);
    const message = decompileTransactionMessage(compiled);
    if (message.feePayer.address !== payer) throw new Error("fee payer changed");
    instructions = message.instructions;
  } catch {
    throw new UserFacingError("The wallet changed the transaction in a way this app cannot verify. Nothing was sent.");
  }
  if (!containsInOrder(instructions, expected)) {
    throw new UserFacingError("The wallet removed or altered a bridge instruction. Nothing was sent.");
  }
  return signed;
}

function sameInstruction(a: Instruction, b: Instruction): boolean {
  if (a.programAddress !== b.programAddress) return false;
  const aData = a.data ?? new Uint8Array();
  const bData = b.data ?? new Uint8Array();
  if (aData.length !== bData.length || aData.some((byte, i) => byte !== bData[i])) return false;
  const aAccounts = a.accounts ?? [];
  const bAccounts = b.accounts ?? [];
  return aAccounts.length === bAccounts.length && aAccounts.every((meta, i) => meta.address === bAccounts[i].address && meta.role === bAccounts[i].role);
}

export function containsInOrder(actual: readonly Instruction[], expected: readonly Instruction[]): boolean {
  let cursor = 0;
  for (const ix of actual) {
    if (cursor < expected.length && sameInstruction(ix, expected[cursor])) cursor++;
  }
  return cursor === expected.length;
}
