import { decodeEventLog, formatUnits, getAddress, type Address, type Hex } from "viem";

import { BRIDGE_ABI, CONFIG, ERC20_ABI } from "./config";
import {
  assertBridgeActive,
  assertSingleBridgeEventCount,
  isTransactionReceiptPending,
  nextRootBlock,
  rootBlocksRemaining
} from "./bridge-logic";
import {
  getIncomingMessagePda,
  getOutputRootPda,
  getSolanaBridgeState,
  parseBaseToSolanaTransfer,
  readIncomingMessageExecuted,
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
  assertBridgeActive(bridgeState.paused);
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
    if (readIncomingMessageExecuted(incomingInfo.data, event.message.data)) {
      return {
        ...common,
        status: "claimed",
        humanStatus: "Claim confirmed on Solana. The incoming bridge message has already executed."
      };
    }

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
    rootBlocksBehind: rootBlocksRemaining(receipt.blockNumber, bridgeState.baseBlockNumber, bridgeState.blockIntervalRequirement)
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
