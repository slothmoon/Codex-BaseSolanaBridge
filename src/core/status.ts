import type { Address } from "@solana/kit";
import { hexToBytes, isHash, type Hex, type PublicClient } from "viem";

import { NETWORK } from "../config";
import { ERC20_WRAPPER_ABI, lookupBridgeTransaction, type BridgeEvent } from "../chain/base";
import { fetchAccounts, type SolanaRpc } from "../chain/solana";
import { decodeBridgeAccount, decodeIncomingMessage, decodeMint, type BridgeAccount } from "../protocol/accounts";
import { SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from "../protocol/constants";
import { findBridgePda, findIncomingMessagePda } from "../protocol/instructions";
import { decodeBridgeMessage, type BridgeMessage, type BridgeTransfer } from "../protocol/message";

export type TrackedAsset = { symbol: string; decimals: number; tokenProgram: Address | null };

export type TrackedCommon = {
  txHash: Hex;
  baseBlock: bigint;
  baseSender: Hex;
  event: BridgeEvent;
  message: BridgeMessage;
  incomingMessage: Address;
  bridge: BridgeAccount;
  bridgePda: Address;
};

export type TrackedTransfer = TrackedCommon & { transfer: BridgeTransfer; asset: TrackedAsset };

export type TrackStatus =
  | { state: "not-found"; txHash: Hex }
  | { state: "reverted"; txHash: Hex; baseBlock: bigint }
  | { state: "not-a-bridge-tx"; txHash: Hex; baseBlock: bigint; reason: "no-event" | "multiple-events" }
  /** A bridge message this interface only tracks (calls, or transfers with follow-up instructions). */
  | ({ state: "unsupported"; reason: string; executed: boolean | null } & TrackedCommon)
  | ({ state: "waiting-for-root"; eta: RootEta } & TrackedTransfer)
  | ({ state: "ready" } & TrackedTransfer)
  | ({ state: "proven" } & TrackedTransfer)
  | ({ state: "claimed" } & TrackedTransfer);

export type RootEta = {
  /** First output-root block that covers this burn. */
  eligibleRootBlock: bigint;
  /** Rough seconds until an eligible root is registered on Solana. */
  seconds: number;
};

/** Validators register a root shortly after its Base block is finalized. */
export const ROOT_REGISTRATION_DELAY_SECONDS = 120;

export function parseTxHash(input: string): Hex {
  const value = input.trim();
  if (!isHash(value)) throw new Error("Enter a Base transaction hash: 0x followed by 64 hex characters.");
  return value;
}

/**
 * Output roots exist only at multiples of the interval and only for finalized Base blocks (they are
 * not registered on a fixed schedule — a root appears once there is a new message to cover). So the
 * wait is: until the first eligible root block is finalized, plus a short registration delay.
 */
export function estimateRootEta(baseBlock: bigint, finalizedBlock: bigint, interval: bigint): RootEta {
  const eligibleRootBlock = interval > 0n ? ((baseBlock + interval - 1n) / interval) * interval : baseBlock;
  const blocksUntilFinal = eligibleRootBlock > finalizedBlock ? eligibleRootBlock - finalizedBlock : 0n;
  const seconds = Number(blocksUntilFinal) * NETWORK.base.blockTimeSeconds + ROOT_REGISTRATION_DELAY_SECONDS;
  return { eligibleRootBlock, seconds };
}

export async function loadBridgeState(rpc: SolanaRpc): Promise<{ pda: Address; account: BridgeAccount }> {
  const pda = await findBridgePda(NETWORK.solana.bridgeProgram);
  const [raw] = await fetchAccounts(rpc, [pda]);
  if (!raw) throw new Error("The Solana bridge account was not found.");
  if (raw.owner !== NETWORK.solana.bridgeProgram) throw new Error("The Solana bridge account has an unexpected owner.");
  return { pda, account: decodeBridgeAccount(raw.data) };
}

export async function trackTransaction(input: { txHash: Hex; base: PublicClient; rpc: SolanaRpc }): Promise<TrackStatus> {
  const { txHash, base, rpc } = input;
  const lookup = await lookupBridgeTransaction(base, txHash);
  if (lookup.status === "not-found") return { state: "not-found", txHash };
  if (lookup.status === "reverted") return { state: "reverted", txHash, baseBlock: lookup.blockNumber };
  if (lookup.status === "no-bridge-event" || lookup.status === "multiple-bridge-events") {
    return { state: "not-a-bridge-tx", txHash, baseBlock: lookup.blockNumber, reason: lookup.status === "no-bridge-event" ? "no-event" : "multiple-events" };
  }

  const { event, blockNumber } = lookup;
  const data = hexToBytes(event.data);
  const message = decodeBridgeMessage(data);
  const [bridgeState, incomingMessage] = await Promise.all([loadBridgeState(rpc), findIncomingMessagePda(NETWORK.solana.bridgeProgram, event.messageHash)]);

  const common: TrackedCommon = {
    txHash,
    baseBlock: blockNumber,
    baseSender: lookup.from,
    event,
    message,
    incomingMessage,
    bridge: bridgeState.account,
    bridgePda: bridgeState.pda
  };

  const [incoming] = await fetchAccounts(rpc, [incomingMessage]);
  const executed = readExecuted(incoming, data.length);

  if (message.type === "call" || message.instructionCount > 0) {
    return {
      state: "unsupported",
      reason: message.type === "call"
        ? "This is a cross-chain call, not a token return. This interface only tracks it."
        : "This transfer carries extra Solana instructions. This interface only claims plain returns.",
      executed: executed === "missing" ? null : executed === "executed",
      ...common
    };
  }

  const asset = await describeAsset(message.transfer, base, rpc);
  const tracked: TrackedTransfer = { ...common, transfer: message.transfer, asset };
  if (executed === "executed") return { state: "claimed", ...tracked };
  if (executed === "proven") return { state: "proven", ...tracked };
  if (bridgeState.account.baseBlockNumber >= blockNumber) return { state: "ready", ...tracked };

  const finalized = await base.getBlock({ blockTag: "finalized" }).then((block) => block.number);
  return {
    state: "waiting-for-root",
    eta: estimateRootEta(blockNumber, finalized, bridgeState.account.blockIntervalRequirement),
    ...tracked
  };
}

function readExecuted(account: { owner: Address; data: Uint8Array } | null, messageLength: number): "missing" | "proven" | "executed" {
  // A system-owned address with lamports is just prefunded; `prove_message` still has to run.
  if (!account || account.owner === SYSTEM_PROGRAM) return "missing";
  if (account.owner !== NETWORK.solana.bridgeProgram) throw new Error("The incoming message account has an unexpected owner.");
  return decodeIncomingMessage(account.data, messageLength).executed ? "executed" : "proven";
}

async function describeAsset(transfer: BridgeTransfer, base: PublicClient, rpc: SolanaRpc): Promise<TrackedAsset> {
  if (transfer.kind === "sol") return { symbol: "SOL", decimals: 9, tokenProgram: null };

  const [mintAccount] = await fetchAccounts(rpc, [transfer.mint]);
  if (!mintAccount) throw new Error(`The Solana mint ${transfer.mint} was not found.`);
  if (mintAccount.owner !== TOKEN_PROGRAM && mintAccount.owner !== TOKEN_2022_PROGRAM) {
    throw new Error("The Solana mint is owned by an unsupported token program.");
  }
  const { decimals } = decodeMint(mintAccount.data);
  let symbol = "";
  if (transfer.kind === "spl") {
    symbol = await base
      .readContract({ address: transfer.baseToken, abi: ERC20_WRAPPER_ABI, functionName: "symbol" })
      .catch(() => "");
  }
  return { symbol: symbol || "tokens", decimals, tokenProgram: mintAccount.owner };
}
