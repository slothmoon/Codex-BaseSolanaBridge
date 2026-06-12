import { PublicKey, Transaction } from "@solana/web3.js";
import { decodeEventLog, formatUnits, getAddress, type Address, type Hex } from "viem";

import { BRIDGE_ABI, CONFIG, ERC20_ABI } from "./config";
import {
  buildClaimTransaction,
  buildRelayOnlyTransaction,
  getIncomingMessagePda,
  getOutputRootPda,
  getSolanaBridgeState,
  incomingMessageAccountSpace,
  parseBaseToSolanaTransfer,
  readMintInfo,
  type ParsedTransfer
} from "./solana";
import { getBaseClient, solana, state, STORAGE_KEY, type BridgeStatus, type SolanaProvider } from "./shared";
import {
  errorMessage,
  formatSolanaError,
  formatSolanaFailure,
  lamportsToSol,
  readTxHash,
  renderStatus,
  setStatus
} from "./ui";
import { connectSolana, getSolanaProvider } from "./wallets";

export async function checkStatus(): Promise<void> {
  const txHash = readTxHash();
  setStatus("Reading the Base receipt and Solana bridge state...");
  const status = await refreshStatus(txHash);
  state.currentStatus = status;
  renderStatus(status);
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
  if (!status.messageData || !status.messageHash || status.messageNonce === undefined || !status.sender || !status.incomingMessage) {
    throw new Error("The bridge message is incomplete.");
  }

  const payer = new PublicKey(state.solanaAccount);
  const bridgeState = await getSolanaBridgeState(solana, CONFIG.solanaBridgeProgram);
  const incomingInfo = await solana.getAccountInfo(status.incomingMessage, "confirmed");

  setStatus("Building the Solana claim transaction in your browser...");
  let transaction: Transaction;
  let transfer: ParsedTransfer;

  if (incomingInfo) {
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

  await assertEnoughSol(transaction, payer, status, transfer);
  setStatus("Simulating the complete Solana claim before asking for a signature...");
  let simulation;
  try {
    // Legacy Transaction uses the legacy simulateTransaction overload. Passing a
    // VersionedTransaction config object here causes web3.js to throw "Invalid arguments".
    simulation = await solana.simulateTransaction(transaction);
  } catch (error) {
    throw new Error(await formatSolanaError("Could not simulate the Solana claim", error, solana));
  }
  if (simulation.value.err) {
    throw new Error(formatSolanaFailure("Solana simulation failed", simulation.value.err, simulation.value.logs));
  }

  setStatus("Simulation passed. Confirm the Solana claim in your wallet.");
  const signature = await sendSolanaTransaction(provider, transaction);
  localStorage.setItem(`${STORAGE_KEY}:claim:${txHash}`, signature);
  setStatus(`Claim submitted on Solana:\n${signature}\n\nThe transaction has been broadcast. You can verify it in Solana Explorer.`);
}

async function refreshStatus(txHash: Hex): Promise<BridgeStatus> {
  const baseClient = getBaseClient();
  const receipt = await baseClient.getTransactionReceipt({ hash: txHash }).catch(() => null);
  if (!receipt) {
    return { status: "waiting_for_base_tx", humanStatus: "Waiting for the Base transaction to appear.", txHash };
  }

  const event = findMessageInitiated(receipt);
  if (!event) {
    return { status: "not_bridge_tx", humanStatus: "The transaction exists but did not emit a bridge MessageInitiated event.", txHash };
  }

  const transfer = parseBaseToSolanaTransfer(event.message.data);
  const [bridgeState, mintInfo, tokenSymbol] = await Promise.all([
    getSolanaBridgeState(solana, CONFIG.solanaBridgeProgram),
    readMintInfo(solana, transfer.localMint),
    baseClient.readContract({
      address: getAddress(transfer.remoteToken),
      abi: ERC20_ABI,
      functionName: "symbol"
    }).catch(() => "")
  ]);
  if (bridgeState.paused) throw new Error("The Solana bridge is currently paused. Do not submit a claim until it is unpaused.");
  const displayAmount = `${formatUnits(transfer.amount, mintInfo.decimals)}${tokenSymbol ? ` ${tokenSymbol}` : ""}`;

  const incomingMessage = getIncomingMessagePda(CONFIG.solanaBridgeProgram, event.messageHash);
  const incomingInfo = await solana.getAccountInfo(incomingMessage, "confirmed");

  const common = {
    txHash,
    messageHash: event.messageHash,
    messageNonce: event.message.nonce,
    messageData: event.message.data,
    sender: event.message.sender,
    baseBlockNumber: receipt.blockNumber,
    solanaBaseBlockNumber: bridgeState.baseBlockNumber,
    incomingMessage,
    transfer,
    displayAmount
  } as const;

  if (incomingInfo) {
    return {
      ...common,
      status: "proof_created",
      humanStatus: "The proof account already exists. The Solana relay can be retried."
    };
  }

  if (bridgeState.baseBlockNumber >= receipt.blockNumber) {
    return {
      ...common,
      status: "ready_to_claim",
      humanStatus: "Ready to claim on Solana."
    };
  }

  const nextEligibleRootBlock = nextRootBlock(receipt.blockNumber, bridgeState.blockIntervalRequirement);
  return {
    ...common,
    status: "waiting_for_root",
    humanStatus: `Waiting for a Solana output root at or after Base block ${receipt.blockNumber}.`,
    nextEligibleRootBlock,
    rootBlocksBehind: receipt.blockNumber - bridgeState.baseBlockNumber
  };
}

async function assertEnoughSol(
  transaction: Transaction,
  payer: PublicKey,
  status: BridgeStatus,
  transfer: ParsedTransfer
): Promise<void> {
  const [balance, feeResult, ataInfo] = await Promise.all([
    solana.getBalance(payer, "confirmed"),
    solana.getFeeForMessage(transaction.compileMessage(), "confirmed"),
    solana.getAccountInfo(transfer.toTokenAccount, "confirmed")
  ]);

  let required = BigInt(feeResult.value ?? 5_000);
  if (status.status === "ready_to_claim" && status.messageData) {
    required += BigInt(await solana.getMinimumBalanceForRentExemption(incomingMessageAccountSpace(status.messageData), "confirmed"));
  }
  if (!ataInfo) {
    required += BigInt(await solana.getMinimumBalanceForRentExemption(165, "confirmed"));
  }
  required += 20_000n;

  if (BigInt(balance) < required) {
    throw new Error(
      `Your Solana wallet has ${lamportsToSol(BigInt(balance))} SOL, but this claim is estimated to need about ${lamportsToSol(required)} SOL for account rent and fees. Add SOL, then retry the same Base transaction hash.`
    );
  }
}

async function sendSolanaTransaction(provider: SolanaProvider, transaction: Transaction): Promise<string> {
  if (provider.signTransaction) {
    let signed: Transaction;
    try {
      signed = (await provider.signTransaction(transaction)) || transaction;
    } catch (error) {
      throw new Error(await formatSolanaError("Solana wallet signing failed", error, solana));
    }

    try {
      const signature = await solana.sendRawTransaction(signed.serialize(), {
        preflightCommitment: "confirmed",
        skipPreflight: false
      });
      await solana.confirmTransaction(signature, "confirmed");
      return signature;
    } catch (error) {
      throw new Error(await formatSolanaError("Solana broadcast failed", error, solana));
    }
  }

  if (provider.signAndSendTransaction) {
    try {
      const { signature } = await provider.signAndSendTransaction(transaction);
      await solana.confirmTransaction(signature, "confirmed");
      return signature;
    } catch (error) {
      throw new Error(await formatSolanaError("Solana wallet send failed", error, solana));
    }
  }

  throw new Error("This Solana wallet does not support transaction signing from websites.");
}

function findMessageInitiated(receipt: { logs: readonly { address: Address; topics: readonly Hex[]; data: Hex }[] }): {
  messageHash: Hex;
  message: { nonce: bigint; sender: Hex; data: Hex };
} | null {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== CONFIG.baseBridge.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({
        abi: BRIDGE_ABI,
        topics: log.topics as [Hex, ...Hex[]],
        data: log.data
      });
      if (decoded.eventName === "MessageInitiated") {
        const args = decoded.args as {
          messageHash: Hex;
          message: { nonce: bigint; sender: Hex; data: Hex };
        };
        return { messageHash: args.messageHash, message: args.message };
      }
    } catch {
      // Ignore unrelated logs emitted by the bridge address.
    }
  }
  return null;
}

function nextRootBlock(baseBlockNumber: bigint, interval: bigint): bigint {
  if (interval === 0n) return baseBlockNumber;
  return baseBlockNumber % interval === 0n
    ? baseBlockNumber
    : baseBlockNumber + (interval - (baseBlockNumber % interval));
}
