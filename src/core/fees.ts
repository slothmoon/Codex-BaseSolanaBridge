import type { Address } from "@solana/kit";

import type { SolanaRpc } from "../chain/solana";

/** Micro-lamports per compute unit. */
export const MIN_PRIORITY_FEE = 10_000n;
export const MAX_PRIORITY_FEE = 2_000_000n;

/**
 * Picks the 75th percentile of recent priority fees paid by transactions that wrote to the same
 * accounts, clamped so a quiet period still lands and a spike cannot drain the wallet.
 */
export function choosePriorityFee(recent: readonly bigint[]): bigint {
  if (recent.length === 0) return MIN_PRIORITY_FEE;
  const sorted = [...recent].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const p75 = sorted[Math.floor(0.75 * (sorted.length - 1))];
  return p75 < MIN_PRIORITY_FEE ? MIN_PRIORITY_FEE : p75 > MAX_PRIORITY_FEE ? MAX_PRIORITY_FEE : p75;
}

export async function estimatePriorityFee(rpc: SolanaRpc, writableAccounts: Address[]): Promise<bigint> {
  try {
    const recent = await rpc.getRecentPrioritizationFees(writableAccounts.slice(0, 128)).send();
    return choosePriorityFee((recent as readonly { prioritizationFee: bigint | number }[]).map((entry) => BigInt(entry.prioritizationFee)));
  } catch {
    return MIN_PRIORITY_FEE * 5n;
  }
}

export const LAMPORTS_PER_SIGNATURE = 5_000n;

export function priorityFeeLamports(computeUnits: number, microLamportsPerUnit: bigint): bigint {
  return (BigInt(computeUnits) * microLamportsPerUnit + 999_999n) / 1_000_000n;
}
