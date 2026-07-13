import { decodeEventLog, formatUnits, getAddress, type Address, type Hex } from "viem";

import { BRIDGE_ABI, CONFIG, ERC20_ABI } from "./config";
import {
  assertSingleBridgeEventCount,
  isTransactionReceiptPending,
  nextRootBlock,
  rootBlocksRemaining
} from "./bridge-logic";
import {
  classifyIncomingMessageAccount,
  getIncomingMessagePda,
  getOutputRootPda,
  getSolanaBridgeState,
  parseBaseToSolanaTransfer,
  readMintInfo
} from "./solana";
import { getBaseClient, solana, state, type BridgeStatus } from "./shared";
import { readTxHash, renderStatus, setStatus } from "./ui";

export async function checkStatus(): Promise<void> {
  const txHash = readTxHash();
  setStatus("Reading the Base receipt and Solana bridge state...");
  const status = await refreshStatus(txHash);
  state.currentStatus = status;
  renderStatus(status);
}

export async function refreshStatus(txHash: Hex): Promise<BridgeStatus> {
  const baseClient = getBaseClient();
  let receipt;
  try {
    receipt = await baseClient.getTransactionReceipt({ hash: txHash });
  } catch (error) {
    if (isTransactionReceiptPending(error)) {
      return { status: "waiting_for_base_tx", humanStatus: "Waiting for the Base transaction to appear.", txHash };
    }
    throw error;
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
  const displayAmount = `${formatUnits(transfer.amount, mintInfo.decimals)}${tokenSymbol ? ` ${tokenSymbol}` : ""}`;

  const incomingMessage = getIncomingMessagePda(CONFIG.solanaBridgeProgram, event.messageHash);
  const incomingInfo = await solana.getAccountInfo(incomingMessage, "confirmed");
  const incomingState = classifyIncomingMessageAccount(incomingInfo, CONFIG.solanaBridgeProgram, event.message.data);

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
    displayAmount,
    bridgePaused: bridgeState.paused
  } as const;

  return classifyAvailableMessage({
    common,
    incomingExecuted: incomingState.kind === "initialized" ? incomingState.executed : null,
    latestRootBlock: bridgeState.baseBlockNumber,
    blockIntervalRequirement: bridgeState.blockIntervalRequirement
  });
}

export function classifyAvailableMessage(input: {
  common: Omit<BridgeStatus, "status" | "humanStatus"> & {
    baseBlockNumber: bigint;
    bridgePaused: boolean;
  };
  incomingExecuted: boolean | null;
  latestRootBlock: bigint;
  blockIntervalRequirement: bigint;
}): BridgeStatus {
  const { common, incomingExecuted, latestRootBlock, blockIntervalRequirement } = input;

  if (incomingExecuted === true) {
    return {
      ...common,
      status: "claimed",
      humanStatus: "Claim confirmed on Solana. The incoming bridge message has already executed."
    };
  }

  if (incomingExecuted === false) {
    return {
      ...common,
      status: "proof_created",
      humanStatus: common.bridgePaused
        ? "The proof account exists, but the bridge is paused. Claiming is temporarily unavailable."
        : "The proof account already exists. The Solana relay can be retried."
    };
  }

  if (latestRootBlock >= common.baseBlockNumber) {
    return {
      ...common,
      status: "ready_to_claim",
      humanStatus: common.bridgePaused
        ? "The output root is ready, but the bridge is paused. Claiming is temporarily unavailable."
        : "Ready to claim on Solana."
    };
  }

  const nextEligibleRootBlock = nextRootBlock(common.baseBlockNumber, blockIntervalRequirement);
  return {
    ...common,
    status: "waiting_for_root",
    humanStatus: common.bridgePaused
      ? `The bridge is paused while waiting for an output root at or after Base block ${common.baseBlockNumber}. Status checks remain available.`
      : `Waiting for a Solana output root at or after Base block ${common.baseBlockNumber}.`,
    nextEligibleRootBlock,
    rootBlocksBehind: rootBlocksRemaining(common.baseBlockNumber, latestRootBlock, blockIntervalRequirement)
  };
}

function findMessageInitiated(receipt: { logs: readonly { address: Address; topics: readonly Hex[]; data: Hex }[] }): {
  messageHash: Hex;
  message: { nonce: bigint; sender: Hex; data: Hex };
} | null {
  const events: Array<{
    messageHash: Hex;
    message: { nonce: bigint; sender: Hex; data: Hex };
  }> = [];

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
        events.push({ messageHash: args.messageHash, message: args.message });
      }
    } catch {
      // Ignore unrelated logs emitted by the bridge address.
    }
  }
  assertSingleBridgeEventCount(events.length);
  return events[0] || null;
}
