/**
 * Priority fee in micro-lamports per compute unit. A claim only write-locks accounts nobody else is
 * competing for (its own proof account, the recipient, a bridge vault), so recent-fee lookups for them
 * return zero; a small fixed fee is all that helps it land.
 */
export const PRIORITY_FEE_MICROLAMPORTS = 10_000n;

export const LAMPORTS_PER_SIGNATURE = 5_000n;

export function priorityFeeLamports(computeUnits: number, microLamportsPerUnit: bigint): bigint {
  return (BigInt(computeUnits) * microLamportsPerUnit + 999_999n) / 1_000_000n;
}
