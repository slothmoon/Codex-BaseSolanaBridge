import {
  appendTransactionMessageInstructions,
  blockhash,
  compileTransaction,
  createTransactionMessage,
  getTransactionSize,
  pipe,
  setTransactionMessageComputeUnitLimit,
  setTransactionMessageComputeUnitPrice,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  setTransactionMessageLoadedAccountsDataSizeLimit,
  setTransactionMessagePriorityFeeLamports,
  type Address,
  type Blockhash,
  type Instruction,
  type Transaction
} from "@solana/kit";

import { priorityFeeLamports } from "./fees";

export type TxVersion = 0 | 1;

export const SIZE_LIMIT: Record<TxVersion, number> = { 0: 1232, 1: 4096 };

/** Solana's per-transaction ceilings. */
export const MAX_COMPUTE_UNITS = 1_400_000;
export const MAX_LOADED_ACCOUNTS_DATA = 64 * 1024 * 1024;

export type BuildOptions = {
  version: TxVersion;
  feePayer: Address;
  instructions: readonly Instruction[];
  blockhash: Blockhash;
  lastValidBlockHeight: bigint;
  computeUnitLimit: number;
  microLamportsPerComputeUnit: bigint;
  /** Only v1 carries this in the header; legacy/v0 default to 64 MiB. */
  loadedAccountsDataSizeLimit?: number;
};

export function buildTransaction(options: BuildOptions): Transaction {
  // Legacy/v0 carry compute settings as ComputeBudget instructions (priority = price per unit × limit).
  // v1 carries them in the message header, and its priority fee is a total in lamports.
  const lifetime = { blockhash: options.blockhash, lastValidBlockHeight: options.lastValidBlockHeight };
  if (options.version === 1) {
    return compileTransaction(
      pipe(
        createTransactionMessage({ version: 1 }),
        (m) => setTransactionMessageFeePayer(options.feePayer, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
        (m) => setTransactionMessageComputeUnitLimit(options.computeUnitLimit, m),
        (m) => setTransactionMessagePriorityFeeLamports(priorityFeeLamports(options.computeUnitLimit, options.microLamportsPerComputeUnit), m),
        (m) => setTransactionMessageLoadedAccountsDataSizeLimit(options.loadedAccountsDataSizeLimit ?? MAX_LOADED_ACCOUNTS_DATA, m),
        (m) => appendTransactionMessageInstructions(options.instructions, m)
      )
    );
  }
  return compileTransaction(
    pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayer(options.feePayer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
      (m) => setTransactionMessageComputeUnitLimit(options.computeUnitLimit, m),
      (m) => setTransactionMessageComputeUnitPrice(options.microLamportsPerComputeUnit, m),
      (m) => appendTransactionMessageInstructions(options.instructions, m)
    )
  );
}

// Any valid 32-byte base58 value: sizes don't depend on it, and simulations that replace the blockhash ignore it.
export const PLACEHOLDER_BLOCKHASH = blockhash("11111111111111111111111111111111");

/**
 * Exact wire size of a transaction carrying these instructions plus compute-budget settings.
 * Compute-unit fields are fixed width, so the placeholder values do not change the result.
 */
export function measureTransaction(version: TxVersion, feePayer: Address, instructions: readonly Instruction[]): number {
  return getTransactionSize(
    buildTransaction({
      version,
      feePayer,
      instructions,
      blockhash: PLACEHOLDER_BLOCKHASH,
      lastValidBlockHeight: 0n,
      computeUnitLimit: MAX_COMPUTE_UNITS,
      microLamportsPerComputeUnit: 1n
    })
  );
}

export function fitsInTransaction(version: TxVersion, feePayer: Address, instructions: readonly Instruction[]): boolean {
  try {
    return measureTransaction(version, feePayer, instructions) <= SIZE_LIMIT[version];
  } catch {
    return false;
  }
}
