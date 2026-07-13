import { PublicKey, Transaction, type Connection } from "@solana/web3.js";
import { type Hex } from "viem";

import { refreshStatus } from "./bridge-status";
import { BRIDGE_ABI, CONFIG } from "./config";
import {
  buildClaimTransaction,
  buildRelayOnlyTransaction,
  classifyIncomingMessageAccount,
  getBlockheightConfirmationStrategy,
  getOutputRootPda,
  getSolanaBridgeState,
  incomingMessageAccountSpace,
  type IncomingMessageAccountState,
  type ParsedTransfer
} from "./solana";
import { getBaseClient, solana, state, type SolanaProvider } from "./shared";
import {
  errorMessage,
  formatSolanaError,
  formatSolanaFailure,
  lamportsToSol,
  readTxHash,
  renderStatus,
  setLinkedStatus,
  setStatus
} from "./ui";
import { connectSolana, getSolanaProvider } from "./wallets";

const CLAIM_SOL_BUFFER_LAMPORTS = 1_000_000n;

export type SolanaConfirmationOutcome =
  | { status: "confirmed" }
  | { status: "failed"; reason: unknown; logs?: string[] | null }
  | { status: "unknown"; error: unknown };

export type SolanaSubmissionResult = {
  signature: string;
  confirmation: SolanaConfirmationOutcome;
  warning?: string;
};

type SolanaConfirmationContext = Pick<Transaction, "recentBlockhash" | "lastValidBlockHeight">;

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function encodeSolanaSignature(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) + BigInt(byte);

  let encoded = "";
  while (value > 0n) {
    encoded = BASE58_ALPHABET[Number(value % 58n)] + encoded;
    value /= 58n;
  }

  let leadingZeroes = 0;
  while (leadingZeroes < bytes.length && bytes[leadingZeroes] === 0) leadingZeroes += 1;
  return "1".repeat(leadingZeroes) + encoded;
}

export function getClaimProofAccountSpace(incomingState: IncomingMessageAccountState, messageData: Hex): number {
  return incomingState.kind === "initialized" ? 0 : incomingMessageAccountSpace(messageData);
}

export function additionalRentLamports(requiredRent: bigint, existingLamports: bigint): bigint {
  return requiredRent > existingLamports ? requiredRent - existingLamports : 0n;
}

export function formatUnknownSubmissionMessage(signature: string, error: unknown): string {
  return [
    "The Solana submission outcome could not be verified:",
    signature,
    `Reason: ${errorMessage(error)}`,
    "Do not burn again. Click Check status before retrying the claim."
  ].join("\n\n");
}

export async function claimOnSolana(): Promise<void> {
  const baseClient = getBaseClient();
  if (!state.solanaAccount) await connectSolana();
  const provider = getSolanaProvider();
  if (!provider) throw new Error("Solana wallet disconnected.");

  const txHash = readTxHash();
  setStatus("Refreshing bridge status...");
  const status = await refreshStatus(txHash);
  state.currentStatus = status;
  renderStatus(status);
  if (status.status !== "ready_to_claim" && status.status !== "proof_created") {
    throw new Error(status.humanStatus);
  }
  if (status.bridgePaused) {
    throw new Error("The Solana bridge is currently paused. Claiming is temporarily unavailable; retry the same Base transaction later.");
  }
  if (!status.messageData || !status.messageHash || status.messageNonce === undefined || !status.sender || !status.incomingMessage) {
    throw new Error("The bridge message is incomplete.");
  }

  const payer = new PublicKey(state.solanaAccount);
  const bridgeState = await getSolanaBridgeState(solana, CONFIG.solanaBridgeProgram);
  const incomingInfo = await solana.getAccountInfo(status.incomingMessage, "confirmed");
  const incomingState = classifyIncomingMessageAccount(incomingInfo, CONFIG.solanaBridgeProgram, status.messageData);
  const proofAccountSpace = getClaimProofAccountSpace(incomingState, status.messageData);
  const proofAccountLamports = BigInt(incomingState.lamports);

  setStatus("Building the Solana claim transaction in your browser...");
  let transaction: Transaction;
  let transfer: ParsedTransfer;

  if (incomingState.kind === "initialized") {
    ({ transaction, transfer } = await buildRelayOnlyTransaction({
      connection: solana,
      programId: CONFIG.solanaBridgeProgram,
      payer,
      incomingMessage: status.incomingMessage,
      bridge: bridgeState.bridge,
      data: status.messageData
    }));
  } else {
    const outputRoot = getOutputRootPda(CONFIG.solanaBridgeProgram, bridgeState.baseBlockNumber);
    let proof: readonly Hex[];
    try {
      proof = await baseClient.readContract({
        address: CONFIG.baseBridge,
        abi: BRIDGE_ABI,
        functionName: "generateProof",
        args: [status.messageNonce],
        blockNumber: bridgeState.baseBlockNumber
      });
    } catch (error) {
      throw new Error(`Could not generate the historical Base proof. The configured Base RPC may not support historical eth_call. ${errorMessage(error)}`);
    }

    ({ transaction, transfer } = await buildClaimTransaction({
      connection: solana,
      programId: CONFIG.solanaBridgeProgram,
      payer,
      outputRoot,
      incomingMessage: status.incomingMessage,
      bridge: bridgeState.bridge,
      nonce: status.messageNonce,
      sender: status.sender,
      data: status.messageData,
      proof,
      messageHash: status.messageHash
    }));
  }

  await assertEnoughSol(transaction, payer, transfer, proofAccountSpace, proofAccountLamports);
  setStatus("Simulating the complete Solana claim before asking for a signature...");
  let simulation;
  try {
    simulation = await solana.simulateTransaction(transaction);
  } catch (error) {
    throw new Error(await formatSolanaError("Could not simulate the Solana claim", error, solana));
  }
  if (simulation.value.err) {
    throw new Error(formatSolanaFailure("Solana simulation failed", simulation.value.err, simulation.value.logs));
  }

  setStatus("Simulation passed. Confirm the Solana claim in your wallet.");
  const submission = await sendSolanaTransaction(provider, transaction, solana);
  renderSubmissionResult(submission);
}

export async function confirmSolanaTransaction(
  connection: Connection,
  transaction: SolanaConfirmationContext,
  signature: string
): Promise<SolanaConfirmationOutcome> {
  try {
    const confirmation = await connection.confirmTransaction(
      getBlockheightConfirmationStrategy(transaction, signature),
      "confirmed"
    );
    if (!confirmation.value.err) return { status: "confirmed" };

    let logs: string[] | null | undefined;
    try {
      const result = await connection.getTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0
      });
      logs = result?.meta?.logMessages;
    } catch {
      // The confirmation result is authoritative even if log retrieval fails.
    }
    return { status: "failed", reason: confirmation.value.err, logs };
  } catch (error) {
    try {
      const fallback = await connection.getSignatureStatuses([signature], {
        searchTransactionHistory: true
      });
      const status = fallback.value[0];
      if (status?.err) {
        return { status: "failed", reason: status.err, logs: undefined };
      }
      if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
        return { status: "confirmed" };
      }
    } catch {
      // Preserve the original confirmation error if the one-shot fallback also fails.
    }
    return { status: "unknown", error };
  }
}

export async function sendSolanaTransaction(
  provider: SolanaProvider,
  transaction: Transaction,
  connection: Connection
): Promise<SolanaSubmissionResult> {
  let signature: string;
  let warning: string | undefined;
  const confirmationContext: SolanaConfirmationContext = {
    recentBlockhash: transaction.recentBlockhash,
    lastValidBlockHeight: transaction.lastValidBlockHeight
  };

  if (provider.signTransaction) {
    const expectedFeePayer = transaction.feePayer;
    let signed: Transaction;
    try {
      signed = (await provider.signTransaction(transaction)) || transaction;
    } catch (error) {
      throw new Error(await formatSolanaError("Solana wallet signing failed", error, connection));
    }
    const feePayer = signed.feePayer;
    if (!expectedFeePayer || !feePayer || !feePayer.equals(expectedFeePayer)) {
      throw new Error("Solana wallet returned a transaction with an unexpected fee payer. Nothing was submitted.");
    }
    const payerSignature = signed.signatures.find(({ publicKey }) => publicKey.equals(feePayer))?.signature;
    if (!payerSignature) {
      throw new Error("Solana wallet did not sign the transaction. Nothing was submitted.");
    }
    const localSignature = encodeSolanaSignature(payerSignature);

    try {
      const rpcSignature = await connection.sendRawTransaction(signed.serialize(), {
        preflightCommitment: "confirmed",
        skipPreflight: false
      });
      signature = localSignature;
      if (rpcSignature !== localSignature) {
        warning = `The Solana RPC returned unexpected signature ${rpcSignature}. Tracking the canonical signed transaction ${localSignature}.`;
      }
    } catch (error) {
      return {
        signature: localSignature,
        confirmation: {
          status: "unknown",
          error: new Error(await formatSolanaError("Solana submission could not be verified", error, connection))
        }
      };
    }
  } else if (provider.signAndSendTransaction) {
    try {
      ({ signature } = await provider.signAndSendTransaction(transaction));
    } catch (error) {
      throw new Error(await formatSolanaError("Solana wallet send failed", error, connection));
    }
  } else {
    throw new Error("This Solana wallet does not support transaction signing from websites.");
  }

  return {
    signature,
    confirmation: await confirmSolanaTransaction(connection, confirmationContext, signature),
    ...(warning ? { warning } : {})
  };
}

function renderSubmissionResult(result: SolanaSubmissionResult): void {
  const cluster = CONFIG.env === "testnet" ? "?cluster=devnet" : "";
  const explorerUrl = `https://explorer.solana.com/tx/${result.signature}${cluster}`;

  if (result.confirmation.status === "failed") {
    throw new Error(formatSolanaFailure(
      `${result.warning ? `${result.warning}\n\n` : ""}Solana claim failed on-chain. Retry the same Base transaction hash; do not burn again`,
      result.confirmation.reason,
      result.confirmation.logs
    ));
  }

  applyConfirmationToClaimState(result.confirmation);

  if (result.confirmation.status === "unknown") {
    setLinkedStatus(
      `${result.warning ? `${result.warning}\n\n` : ""}${formatUnknownSubmissionMessage(result.signature, result.confirmation.error)}`,
      "View on Solana Explorer",
      explorerUrl,
      "info"
    );
    return;
  }

  setLinkedStatus(
    `${result.warning ? `${result.warning}\n\n` : ""}Claim confirmed on Solana:\n${result.signature}`,
    "View on Solana Explorer",
    explorerUrl
  );
}

export function applyConfirmationToClaimState(confirmation: SolanaConfirmationOutcome): void {
  if (confirmation.status === "confirmed" && state.currentStatus) {
    state.currentStatus = {
      ...state.currentStatus,
      status: "claimed",
      humanStatus: "Claim confirmed on Solana."
    };
  } else if (confirmation.status === "unknown") {
    state.currentStatus = null;
  }
}

async function assertEnoughSol(
  transaction: Transaction,
  payer: PublicKey,
  transfer: ParsedTransfer,
  proofAccountSpace: number,
  proofAccountLamports: bigint
): Promise<void> {
  const [balance, feeResult, ataInfo] = await Promise.all([
    solana.getBalance(payer, "confirmed"),
    solana.getFeeForMessage(transaction.compileMessage(), "confirmed"),
    solana.getAccountInfo(transfer.toTokenAccount, "confirmed")
  ]);

  let required = BigInt(feeResult.value ?? 5_000);
  if (proofAccountSpace > 0) {
    const proofRent = BigInt(await solana.getMinimumBalanceForRentExemption(proofAccountSpace, "confirmed"));
    required += additionalRentLamports(proofRent, proofAccountLamports);
  }
  if (!ataInfo) {
    // This is a conservative preliminary estimate for a standard token account.
    // Complete simulation remains authoritative, especially for Token-2022 accounts.
    required += BigInt(await solana.getMinimumBalanceForRentExemption(165, "confirmed"));
  }
  required += CLAIM_SOL_BUFFER_LAMPORTS;

  if (BigInt(balance) < required) {
    throw new Error(
      `Your Solana wallet has ${lamportsToSol(BigInt(balance))} SOL, but this claim is estimated to need about ${lamportsToSol(required)} SOL for account rent and fees. Add SOL, then retry the same Base transaction hash.`
    );
  }
}
