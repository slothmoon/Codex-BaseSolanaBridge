import { TransactionReceiptNotFoundError } from "viem";

export function isBurnValidationCurrent(expectedKey: string, validatedKey: string, currentKey: string): boolean {
  return Boolean(expectedKey) && validatedKey === expectedKey && currentKey === expectedKey;
}

export function assertBridgeActive(paused: boolean): void {
  if (paused) {
    throw new Error("The Solana bridge is currently paused. Nothing was submitted. Wait until it is unpaused, then try again.");
  }
}

export function isTransactionReceiptPending(error: unknown): boolean {
  let current: unknown = error;
  const seen = new Set<unknown>();

  while (current && typeof current === "object" && !seen.has(current)) {
    if (current instanceof TransactionReceiptNotFoundError) return true;
    if ((current as { name?: unknown }).name === "TransactionReceiptNotFoundError") return true;
    seen.add(current);
    current = (current as { cause?: unknown }).cause;
  }

  return false;
}

export function nextRootBlock(baseBlockNumber: bigint, interval: bigint): bigint {
  if (interval === 0n) return baseBlockNumber;
  return baseBlockNumber % interval === 0n
    ? baseBlockNumber
    : baseBlockNumber + (interval - (baseBlockNumber % interval));
}

export function rootBlocksRemaining(baseBlockNumber: bigint, latestRootBlock: bigint, interval: bigint): bigint {
  const nextEligibleRoot = nextRootBlock(baseBlockNumber, interval);
  return nextEligibleRoot > latestRootBlock ? nextEligibleRoot - latestRootBlock : 0n;
}

export function assertSingleBridgeEventCount(count: number): void {
  if (count > 1) {
    throw new Error("This transaction contains multiple bridge messages. Use a transaction with exactly one plain SPL return.");
  }
}
