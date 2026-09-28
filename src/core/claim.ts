import {
  createNoopSigner,
  decompileTransactionMessage,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getPublicKeyFromAddress,
  getSignatureFromTransaction,
  getTransactionDecoder,
  getTransactionEncoder,
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
import { decodeMint, decodeOutputRoot, decodeTokenAccount, incomingMessageSpace } from "../protocol/accounts";
import { SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from "../protocol/constants";
import { findOutputRootPda, findTokenVaultPda, relayRemainingAccounts } from "../protocol/instructions";
import { verifyMmrProof } from "../protocol/mmr";
import { planClaim, type ClaimPlan, type ProofState } from "./claim-plan";
import { explainLogs, explainTransactionError, UserFacingError } from "./errors";
import { LAMPORTS_PER_SIGNATURE, PRIORITY_FEE_MICROLAMPORTS, priorityFeeLamports } from "./fees";
import { rehearseRelease } from "./rehearsal";
import type { TrackedTransfer } from "./status";
import { buildTransaction, MAX_COMPUTE_UNITS, MAX_LOADED_ACCOUNTS_DATA } from "./tx";

/** What the app needs from a connected Solana wallet. */
export type SolanaSigner = {
  address: Address;
  supportsV1: boolean;
  /** Signs (does not send) a wire transaction and returns the signed wire bytes. */
  signTransaction(wire: Uint8Array): Promise<Uint8Array>;
};

export type PreparedClaim = {
  status: TrackedTransfer;
  payer: Address;
  plan: ClaimPlan;
  cost: { networkFees: bigint; newAccountRent: bigint; required: bigint; balance: bigint };
};

const ROUGH_UNITS_PER_TX = 200_000;

export async function prepareClaim(input: {
  status: TrackedTransfer & { state: "ready" | "proven" };
  payer: Address;
  supportsV1: boolean;
  rpc: SolanaRpc;
  base: PublicClient;
}): Promise<PreparedClaim> {
  const { status, payer, rpc } = input;
  const program = NETWORK.solana.bridgeProgram;
  const transfer = status.transfer;
  const messageData = hexToBytes(status.event.data);

  // ---- Everything needed from Solana, in one request (the payer's balance comes from its account) --
  const rootBlock = status.bridge.baseBlockNumber;
  const outputRoot = await findOutputRootPda(program, rootBlock);
  const [payerAccount, outputRootAccount, incomingAccount, destinationAccount, mintAccount = null] = await fetchAccounts(rpc, [
    payer,
    outputRoot,
    status.incomingMessage,
    transfer.to,
    ...(transfer.kind === "sol" ? [] : [transfer.mint])
  ]);

  // ---- Proof against the latest output root, checked locally before anything is signed --------
  let proofState: ProofState = { kind: "proven" };
  let incomingLamports = 0n;
  if (status.state === "ready") {
    if (!outputRootAccount || outputRootAccount.owner !== program) throw new UserFacingError("The Solana output root for this claim was not found. Click Track to refresh the status, then try again.");
    const root = decodeOutputRoot(outputRootAccount.data);
    if (incomingAccount?.owner === SYSTEM_PROGRAM) incomingLamports = incomingAccount.lamports;

    let proof;
    try {
      proof = await generateProof(input.base, status.event.nonce, rootBlock);
    } catch (error) {
      throw new UserFacingError("Could not generate the proof on Base. Try again in a moment.", String((error as Error)?.message ?? error));
    }
    if (!verifyMmrProof({ root: root.root, leafHash: status.event.messageHash, leafIndex: status.event.nonce, proof, totalLeafCount: root.totalLeafCount })) {
      throw new UserFacingError("The proof from Base does not match the output root on Solana, so nothing was sent. Click Track to refresh the status, then try again.");
    }
    proofState = { kind: "unproven", outputRoot, proof };
  }

  // ---- Destination -------------------------------------------------------------------------------
  let createDestination: Instruction | null = null;
  let destinationRent = 0n;
  let tokenProgram: Address | null = null;

  if (transfer.kind === "sol") {
    const rentFloor = await fetchMinimumRent(rpc, 0);
    if (!destinationAccount && transfer.amount < rentFloor) {
      throw new UserFacingError("The recipient wallet is empty and this amount is below Solana's minimum account balance, so the claim cannot succeed until the recipient wallet holds some SOL.");
    }
  } else {
    if (!mintAccount) throw new UserFacingError("The Solana mint no longer exists.");
    tokenProgram = mintAccount.owner;
    if (tokenProgram !== TOKEN_PROGRAM && tokenProgram !== TOKEN_2022_PROGRAM) throw new UserFacingError("The Solana mint uses an unsupported token program.");
    if (destinationAccount && decodeTokenAccount(destinationAccount.data).mint !== transfer.mint) {
      throw new UserFacingError("The destination token account is for a different mint.");
    }

    let createForOwner: Address | null = null;
    if (!destinationAccount) {
      const [payerAta] = await findAssociatedTokenPda({ owner: payer, mint: transfer.mint, tokenProgram });
      if (payerAta !== transfer.to) {
        throw new UserFacingError(
          `The destination token account ${transfer.to} does not exist yet and is not your wallet's token account, so only its owner can create it. Connect the recipient's Solana wallet to claim.`
        );
      }
      createForOwner = payer;
      createDestination = getCreateAssociatedTokenIdempotentInstruction({ payer: createNoopSigner(payer), ata: payerAta, owner: payer, mint: transfer.mint, tokenProgram });
      destinationRent = await fetchMinimumRent(rpc, 170); // refined by the dry run below for SPL returns
    }

    // SPL returns: dry-run the vault release first, so a claim that cannot succeed fails here, before
    // the user pays for a proof. (Wrapped-token claims mint through the bridge; the relay simulation covers them.)
    if (transfer.kind === "spl") {
      const rehearsal = await rehearseRelease({
        kind: "spl",
        rpc,
        amount: transfer.amount,
        mint: transfer.mint,
        decimals: decodeMint(mintAccount.data).decimals,
        tokenProgram,
        vault: await findTokenVaultPda(program, transfer.mint, transfer.baseToken),
        destination: transfer.to,
        createForOwner
      });
      if (!rehearsal.ok) {
        throw new UserFacingError(`A dry run of the release from the bridge vault fails right now (${rehearsal.reason}), so the claim would fail. Your funds stay in the bridge; try again once that changes.`);
      }
      if (createForOwner) destinationRent = await fetchMinimumRent(rpc, rehearsal.destinationSpace);
    }
  }

  const plan = planClaim(
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
      relayRemainingAccounts: await relayRemainingAccounts(program, transfer, tokenProgram)
    },
    { supportsV1: input.supportsV1 }
  );

  // ---- Cost ----------------------------------------------------------------------------------
  const networkFees = BigInt(plan.txs.length) * (LAMPORTS_PER_SIGNATURE + priorityFeeLamports(ROUGH_UNITS_PER_TX, PRIORITY_FEE_MICROLAMPORTS));
  let newAccountRent = destinationRent;
  if (proofState.kind === "unproven") {
    const proofRent = await fetchMinimumRent(rpc, incomingMessageSpace(messageData.length));
    newAccountRent += proofRent > incomingLamports ? proofRent - incomingLamports : 0n;
  }

  return {
    status,
    payer,
    plan,
    cost: { networkFees, newAccountRent, required: networkFees + newAccountRent, balance: payerAccount?.lamports ?? 0n }
  };
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

/**
 * Runs the plan one transaction at a time: simulate, right-size compute, sign, send, confirm.
 * Each transaction is simulated before signing, so a claim someone else already finished stops with
 * "already claimed" and nothing is sent. Every step is resumable from on-chain state.
 */
export async function executeClaim(input: {
  prepared: PreparedClaim;
  signer: SolanaSigner;
  rpc: SolanaRpc;
  onProgress: (progress: ClaimProgress) => void;
}): Promise<{ signatures: string[] }> {
  const { prepared, signer, rpc } = input;
  if (signer.address !== prepared.payer) throw new UserFacingError("The connected Solana wallet changed. Review the claim again.");
  const { plan } = prepared;
  const signatures: string[] = [];

  for (const [index, tx] of plan.txs.entries()) {
    const report = (phase: ClaimProgress["phase"], signature?: string) => input.onProgress({ index, total: plan.txs.length, label: tx.label, phase, signature });

    report("simulating");
    const { value: latest } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
    const base = {
      version: plan.version,
      feePayer: prepared.payer,
      instructions: tx.instructions,
      blockhash: latest.blockhash,
      lastValidBlockHeight: BigInt(latest.lastValidBlockHeight),
      microLamportsPerComputeUnit: PRIORITY_FEE_MICROLAMPORTS
    };
    const probe = buildTransaction({ ...base, computeUnitLimit: MAX_COMPUTE_UNITS, loadedAccountsDataSizeLimit: MAX_LOADED_ACCOUNTS_DATA });
    const simulation = await rpc
      .simulateTransaction(getBase64EncodedWireTransaction(probe), { encoding: "base64", sigVerify: false, replaceRecentBlockhash: false, commitment: "confirmed" })
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
    const signed = await checkWalletSignature(await signer.signTransaction(new Uint8Array(getTransactionEncoder().encode(transaction))), prepared.payer);
    const signature = getSignatureFromTransaction(signed);
    const wire = getBase64EncodedWireTransaction(signed);

    report("sending", signature);
    try {
      await sendWireTransaction(rpc, wire, true);
    } catch (error) {
      const text = String((error as Error)?.message ?? error);
      if (!/already been processed|AlreadyProcessed/i.test(text)) {
        // Kit puts preflight logs in `context.logs`; the transaction error itself is only on `cause`.
        const logs = (error as { context?: { logs?: string[] } }).context?.logs ?? [];
        throw new UserFacingError(`Solana rejected the transaction before it was sent, so no fee was charged: ${explainLogs(logs) ?? text}`, [text, ...logs].join("\n"));
      }
    }

    report("confirming", signature);
    const outcome = await waitForSignature(rpc, signature, BigInt(latest.lastValidBlockHeight), { resend: () => sendWireTransaction(rpc, wire, false) });
    if (outcome.status === "expired") {
      throw new UserFacingError(`"${tx.label}" did not land before its blockhash expired. Nothing was lost — review the claim again to continue where it stopped.`);
    }
    if (outcome.status === "failed") {
      throw new UserFacingError(`"${tx.label}" failed on Solana: ${explainTransactionError(outcome.error, instructionPrograms(transaction))} Review the claim again to retry.`);
    }
    signatures.push(signature);
    report("confirmed", signature);
  }
  return { signatures };
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

/** The wallet must return the transaction signed by the connected account, paying the fee (as in v1). */
export async function checkWalletSignature(signedWire: Uint8Array, payer: Address): Promise<Transaction> {
  let signed: Transaction;
  try {
    signed = getTransactionDecoder().decode(signedWire) as Transaction;
  } catch {
    throw new UserFacingError("The wallet returned a transaction that could not be decoded. Nothing was sent.");
  }
  const feePayer = getCompiledTransactionMessageDecoder().decode(signed.messageBytes).staticAccounts[0];
  if (feePayer !== payer) throw new UserFacingError("The wallet returned a transaction with a different fee payer. Nothing was sent.");
  const signature = signed.signatures[payer];
  if (!signature || !(await verifySignature(await getPublicKeyFromAddress(payer), signature, signed.messageBytes))) {
    throw new UserFacingError("The wallet did not sign with the connected account. Nothing was sent.");
  }
  return signed;
}
