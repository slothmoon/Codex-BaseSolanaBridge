import {
  createDefaultRpcTransport,
  createSolanaRpcFromTransport,
  getBase64Encoder,
  type Address,
  type Base64EncodedWireTransaction,
  type RpcTransport,
  type Signature
} from "@solana/kit";

import { NETWORK } from "../config";

/**
 * Tries each RPC in order and moves on only when a request fails at the transport level
 * (network error, HTTP 429/5xx). JSON-RPC errors are returned to the caller untouched, so a
 * rejected transaction is never silently re-broadcast somewhere else with a different outcome.
 */
export function createFallbackTransport(urls: string[]): RpcTransport {
  if (urls.length === 0) throw new Error("At least one Solana RPC URL is required.");
  const transports = urls.map((url) => createDefaultRpcTransport({ url }));
  return (async (config: Parameters<RpcTransport>[0]) => {
    let lastError: unknown;
    for (const transport of transports) {
      try {
        return await transport(config);
      } catch (error) {
        lastError = error;
        if (config.signal?.aborted) break;
      }
    }
    throw lastError;
  }) as RpcTransport;
}

export type SolanaRpc = ReturnType<typeof createSolanaRpcFromTransport>;

let rpcSingleton: SolanaRpc | null = null;

export function getSolanaRpc(): SolanaRpc {
  rpcSingleton ??= createSolanaRpcFromTransport(createFallbackTransport(NETWORK.solana.rpcUrls));
  return rpcSingleton;
}

export type RawAccount = { address: Address; owner: Address; lamports: bigint; data: Uint8Array; executable: boolean };

const base64 = getBase64Encoder();

function toRawAccount(address: Address, value: { owner: Address; lamports: bigint; data: readonly [string, string]; executable: boolean } | null): RawAccount | null {
  if (!value) return null;
  return { address, owner: value.owner, lamports: BigInt(value.lamports), data: new Uint8Array(base64.encode(value.data[0])), executable: value.executable };
}

export async function fetchAccount(rpc: SolanaRpc, address: Address): Promise<RawAccount | null> {
  const { value } = await rpc.getAccountInfo(address, { encoding: "base64", commitment: "confirmed" }).send();
  return toRawAccount(address, value as never);
}

/** Fetches up to 100 accounts in one round trip, preserving order. */
export async function fetchAccounts(rpc: SolanaRpc, addresses: Address[]): Promise<(RawAccount | null)[]> {
  if (addresses.length === 0) return [];
  const { value } = await rpc.getMultipleAccounts(addresses, { encoding: "base64", commitment: "confirmed" }).send();
  return (value as readonly unknown[]).map((account, index) => toRawAccount(addresses[index], account as never));
}

export async function fetchMinimumRent(rpc: SolanaRpc, space: number): Promise<bigint> {
  return BigInt(await rpc.getMinimumBalanceForRentExemption(BigInt(space), { commitment: "confirmed" }).send());
}

export type SignatureOutcome = { status: "confirmed" } | { status: "failed"; error: unknown } | { status: "expired" };

/**
 * Polls until the signature is confirmed, fails, or its blockhash can no longer land. Polling (not
 * websockets) keeps this working behind strict CSPs and flaky public RPCs.
 */
export async function waitForSignature(
  rpc: SolanaRpc,
  signature: Signature,
  lastValidBlockHeight: bigint,
  options: { intervalMs?: number; signal?: AbortSignal; resend?: () => Promise<void> } = {}
): Promise<SignatureOutcome> {
  const interval = options.intervalMs ?? 1500;
  for (let attempt = 0; ; attempt++) {
    if (options.signal?.aborted) throw new Error("Cancelled.");
    const { value } = await rpc.getSignatureStatuses([signature], { searchTransactionHistory: false }).send();
    const status = value[0];
    if (status?.err) return { status: "failed", error: status.err };
    if (status && (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized")) return { status: "confirmed" };

    const height = await rpc.getBlockHeight({ commitment: "confirmed" }).send();
    if (BigInt(height) > lastValidBlockHeight) {
      // One last look in case it landed right at the boundary.
      const { value: final } = await rpc.getSignatureStatuses([signature], { searchTransactionHistory: true }).send();
      if (final[0]?.err) return { status: "failed", error: final[0].err };
      return final[0] ? { status: "confirmed" } : { status: "expired" };
    }
    // Re-broadcasting the identical signed bytes is idempotent and helps under congestion.
    if (options.resend && attempt > 0 && attempt % 4 === 0) await options.resend().catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

/**
 * The first broadcast runs RPC preflight so a transaction that would fail (for example because a
 * someone else claimed the message after our simulation) is rejected before it can cost a fee.
 * Re-broadcasts of the same bytes skip preflight, since the original may already be in flight.
 */
export async function sendWireTransaction(rpc: SolanaRpc, wire: Base64EncodedWireTransaction, preflight: boolean): Promise<void> {
  await rpc
    .sendTransaction(wire, { encoding: "base64", skipPreflight: !preflight, preflightCommitment: "confirmed", maxRetries: 0n })
    .send();
}
