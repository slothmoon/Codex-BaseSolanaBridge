import { batch, computed, effect, signal } from "@preact/signals";
import type { WalletAccount } from "@wallet-standard/base";
import { formatUnits, isAddress, type Address, type Hex } from "viem";

import { NETWORK } from "../config";
import { getBaseArchiveClient, getBaseClient } from "../chain/base";
import { findUpgradedComponents } from "../chain/pins";
import { getSolanaRpc } from "../chain/solana";
import { executeClaim, prepareClaim, type ClaimProgress, type PreparedClaim } from "../core/claim";
import { describeError } from "../core/errors";
import { buildRoute, inspectToken, routeKey, type Route, type TokenInspection } from "../core/route";
import { parseTxHash, trackTransaction, type TrackStatus } from "../core/status";
import { forgetBurn, loadHistory, loadPreference, rememberBurn, savePreference, type HistoryEntry } from "../core/storage";
import {
  discoverEvmWallets,
  readEvmChainId,
  requestEvmAccount,
  sendBurn,
  switchToBase,
  watchEvmWallet,
  type EvmWallet
} from "../wallets/evm";
import {
  connectSolanaWallet,
  disconnectSolanaWallet,
  discoverSolanaWallets,
  toSolanaSigner,
  watchSolanaWallet,
  type SolanaWallet
} from "../wallets/solana";

export type Async<T> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string; detail?: string }
  | { status: "ready"; value: T };

const idle = { status: "idle" } as const;
const loading = { status: "loading" } as const;
const failed = (error: unknown): Async<never> => ({ status: "error", ...describeError(error) });

// ---------------------------------------------------------------------------------------------
// Wallets
// ---------------------------------------------------------------------------------------------

export const evmWallets = signal<EvmWallet[]>([]);
export const evmWallet = signal<EvmWallet | null>(null);
export const evmAccount = signal<Address | null>(null);
export const evmChainId = signal<number | null>(null);
export const evmOnBase = computed(() => evmChainId.value === NETWORK.base.chain.id);

export const solanaWallets = signal<SolanaWallet[]>([]);
export const solanaWallet = signal<SolanaWallet | null>(null);
export const solanaAccount = signal<WalletAccount | null>(null);
export const solanaAddress = computed(() => solanaAccount.value?.address ?? null);

export const walletError = signal<string | null>(null);

let stopEvmWatch: (() => void) | null = null;
let stopSolanaWatch: (() => void) | null = null;

export async function connectEvm(wallet: EvmWallet, silent = false): Promise<void> {
  walletError.value = null;
  try {
    const account = await requestEvmAccount(wallet, silent);
    if (!account) return;
    stopEvmWatch?.();
    batch(() => {
      evmWallet.value = wallet;
      evmAccount.value = account;
    });
    evmChainId.value = await readEvmChainId(wallet);
    stopEvmWatch = watchEvmWallet(wallet, {
      accounts: (next) => (evmAccount.value = next),
      chain: (chainId) => (evmChainId.value = chainId)
    });
    savePreference("evm-wallet", wallet.info.rdns);
    if (!silent && !evmOnBase.value) await switchEvmToBase();
  } catch (error) {
    if (!silent) walletError.value = describeError(error).message;
  }
}

export async function switchEvmToBase(): Promise<void> {
  const wallet = evmWallet.value;
  if (!wallet) return;
  try {
    await switchToBase(wallet);
    evmChainId.value = await readEvmChainId(wallet);
  } catch (error) {
    walletError.value = describeError(error).message;
  }
}

export function disconnectEvm(): void {
  stopEvmWatch?.();
  batch(() => {
    evmWallet.value = null;
    evmAccount.value = null;
    evmChainId.value = null;
  });
  savePreference("evm-wallet", null);
}

export async function connectSolana(wallet: SolanaWallet, silent = false): Promise<void> {
  walletError.value = null;
  try {
    const account = await connectSolanaWallet(wallet.wallet, silent);
    if (!account) return;
    stopSolanaWatch?.();
    batch(() => {
      solanaWallet.value = wallet;
      solanaAccount.value = account;
    });
    stopSolanaWatch = watchSolanaWallet(wallet.wallet, (next) => (solanaAccount.value = next));
    savePreference("solana-wallet", wallet.name);
  } catch (error) {
    if (!silent) walletError.value = describeError(error).message;
  }
}

export async function disconnectSolana(): Promise<void> {
  const wallet = solanaWallet.value;
  stopSolanaWatch?.();
  batch(() => {
    solanaWallet.value = null;
    solanaAccount.value = null;
  });
  savePreference("solana-wallet", null);
  if (wallet) await disconnectSolanaWallet(wallet.wallet).catch(() => undefined);
}

// ---------------------------------------------------------------------------------------------
// Return (burn) flow
// ---------------------------------------------------------------------------------------------

export const tokenInput = signal("");
export const amountInput = signal("");
export const inspection = signal<Async<TokenInspection>>(idle);
export const route = signal<Async<Route>>(idle);
export const burnState = signal<Async<Hex>>(idle);
export const acknowledgedWarnings = signal(false);

/** The key the current inputs would produce; a route is only trusted while its key matches. */
export const currentRouteKey = computed(() =>
  routeKey({ token: tokenInput.value, amount: amountInput.value, evm: evmAccount.value ?? "", solana: solanaAddress.value ?? "" })
);

export const activeRoute = computed(() => {
  const value = route.value;
  if (value.status !== "ready") return null;
  const inspected = inspection.value;
  if (inspected.status !== "ready" || inspected.value.wrapper.address.toLowerCase() !== value.value.inspection.wrapper.address.toLowerCase()) return null;
  return value.value.key === routeKey({ token: inspected.value.wrapper.address, amount: amountInput.value, evm: evmAccount.value ?? "", solana: solanaAddress.value ?? "" }) ? value.value : null;
});

let inspectRequest = 0;

export async function runInspection(): Promise<void> {
  const token = tokenInput.value.trim();
  const request = ++inspectRequest;
  route.value = idle;
  if (!isAddress(token, { strict: false })) {
    inspection.value = token ? { status: "error", message: "Enter a valid Base token address (0x…)." } : idle;
    return;
  }
  inspection.value = loading;
  try {
    const result = await inspectToken({ token, holder: evmAccount.value, base: getBaseClient(), rpc: getSolanaRpc() });
    if (request === inspectRequest) inspection.value = { status: "ready", value: result };
  } catch (error) {
    if (request === inspectRequest) inspection.value = failed(error);
  }
}

let routeRequest = 0;

export async function reviewRoute(): Promise<Route | null> {
  const inspected = inspection.value;
  const evm = evmAccount.value;
  const recipient = solanaAddress.value;
  if (inspected.status !== "ready" || !evm || !recipient) return null;
  const request = ++routeRequest;
  const keyAtStart = currentRouteKey.value;
  route.value = loading;
  acknowledgedWarnings.value = false;
  try {
    // Refresh the balance with the connected account, then validate everything.
    const fresh = await inspectToken({ token: inspected.value.wrapper.address, holder: evm, base: getBaseClient(), rpc: getSolanaRpc() });
    const epoch = await getSolanaRpc().getEpochInfo().send().then((info: { epoch: bigint | number }) => BigInt(info.epoch)).catch(() => null);
    const built = await buildRoute({ inspection: fresh, amountInput: amountInput.value, evmAccount: evm, recipientWallet: recipient as never, base: getBaseClient(), rpc: getSolanaRpc(), currentEpoch: epoch });
    if (request !== routeRequest || keyAtStart !== currentRouteKey.value) return null; // inputs changed meanwhile
    inspection.value = { status: "ready", value: fresh };
    route.value = { status: "ready", value: built };
    return built;
  } catch (error) {
    if (request === routeRequest) route.value = failed(error);
    return null;
  }
}

export async function burn(): Promise<void> {
  const wallet = evmWallet.value;
  const reviewed = activeRoute.value;
  if (!wallet || !reviewed) return;
  burnState.value = loading;
  try {
    // Re-validate immediately before signing; abort if anything moved.
    const fresh = await reviewRoute();
    if (!fresh || fresh.key !== reviewed.key) throw new Error("The route changed while it was being re-checked. Review it again before burning.");
    if (fresh.findings.some((finding) => finding.level === "block")) throw new Error("A pre-burn check failed. Review the route again.");
    if (!evmOnBase.value) await switchEvmToBase();

    const hash = await sendBurn(wallet, fresh.evmAccount, fresh.transfer);
    burnState.value = { status: "ready", value: hash };
    history.value = rememberBurn({
      txHash: hash,
      createdAt: Date.now(),
      symbol: fresh.inspection.wrapper.symbol,
      amount: formatUnits(fresh.amount, fresh.inspection.wrapper.decimals)
    });
    route.value = idle;
    amountInput.value = "";
    await track(hash);
  } catch (error) {
    burnState.value = failed(error);
  }
}

// ---------------------------------------------------------------------------------------------
// Track & claim
// ---------------------------------------------------------------------------------------------

export const trackInput = signal("");
export const tracked = signal<Async<TrackStatus>>(idle);
export const trackedSince = signal<number | null>(null);
export const history = signal<HistoryEntry[]>(loadHistory());

export const claimPrep = signal<Async<PreparedClaim>>(idle);
export const claimProgress = signal<ClaimProgress[]>([]);
export const claimRun = signal<Async<{ signatures: string[]; alreadyClaimed: boolean }>>(idle);

let trackRequest = 0;
let pollTimer: number | null = null;

export async function track(input?: string, quiet = false): Promise<void> {
  let hash: Hex;
  try {
    hash = parseTxHash(input ?? trackInput.value);
  } catch (error) {
    tracked.value = failed(error);
    return;
  }
  const request = ++trackRequest;
  const current = tracked.value;
  const sameTx = current.status === "ready" && current.value.txHash.toLowerCase() === hash.toLowerCase();
  if (!sameTx) {
    trackedSince.value = Date.now();
    claimPrep.value = idle;
    claimRun.value = idle;
    claimProgress.value = [];
  }
  trackInput.value = hash;
  if (!quiet || !sameTx) tracked.value = loading;
  syncUrl(hash);
  try {
    const status = await trackTransaction({ txHash: hash, base: getBaseClient(), rpc: getSolanaRpc() });
    if (request !== trackRequest) return;
    tracked.value = { status: "ready", value: status };
    schedulePoll(status);
  } catch (error) {
    if (request !== trackRequest) return;
    if (!quiet || tracked.value.status !== "ready") tracked.value = failed(error);
    schedulePoll(null);
  }
}

function schedulePoll(status: TrackStatus | null): void {
  if (pollTimer !== null) window.clearTimeout(pollTimer);
  pollTimer = null;
  const live = !status || ["not-found", "waiting-for-root", "ready", "proven"].includes(status.state);
  if (!live || claimRun.value.status === "loading") return;
  pollTimer = window.setTimeout(() => {
    if (document.visibilityState === "visible") void track(trackInput.value, true);
    else schedulePoll(status);
  }, status?.state === "not-found" ? 6_000 : 20_000);
}

function syncUrl(hash: Hex): void {
  try {
    const url = new URL(window.location.href);
    url.searchParams.set("tx", hash);
    window.history.replaceState(null, "", url);
  } catch {
    // Non-essential.
  }
}

export function removeFromHistory(hash: Hex): void {
  history.value = forgetBurn(hash);
}

export async function reviewClaim(): Promise<void> {
  const status = tracked.value.status === "ready" ? tracked.value.value : null;
  const account = solanaAccount.value;
  const wallet = solanaWallet.value;
  if (!status || (status.state !== "ready" && status.state !== "proven") || !account || !wallet) return;
  claimPrep.value = loading;
  claimRun.value = idle;
  claimProgress.value = [];
  try {
    const signer = toSolanaSigner(wallet.wallet, account);
    const prepared = await prepareClaim({ status, payer: signer.address, supportsV1: signer.supportsV1, rpc: getSolanaRpc(), archive: getBaseArchiveClient() });
    claimPrep.value = { status: "ready", value: prepared };
  } catch (error) {
    claimPrep.value = failed(error);
  }
}

export async function runClaim(): Promise<void> {
  const prep = claimPrep.value.status === "ready" ? claimPrep.value.value : null;
  const account = solanaAccount.value;
  const wallet = solanaWallet.value;
  if (!prep || !account || !wallet) return;
  if (pollTimer !== null) window.clearTimeout(pollTimer);
  claimRun.value = loading;
  claimProgress.value = [];
  try {
    const result = await executeClaim({
      prepared: prep,
      signer: toSolanaSigner(wallet.wallet, account),
      rpc: getSolanaRpc(),
      onProgress: (progress) => {
        const list = claimProgress.value.filter((item) => item.index !== progress.index);
        claimProgress.value = [...list, progress].sort((a, b) => a.index - b.index);
      },
      isAlreadyClaimed: async () => {
        const status = await trackTransaction({ txHash: prep.status.txHash, base: getBaseClient(), rpc: getSolanaRpc() });
        return status.state === "claimed";
      }
    });
    claimRun.value = { status: "ready", value: result };
  } catch (error) {
    claimRun.value = failed(error);
  } finally {
    claimPrep.value = idle;
    await track(prep.status.txHash, true);
  }
}

// ---------------------------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------------------------

export const upgradedComponents = signal<string[]>([]);

export function startApp(): void {
  discoverEvmWallets((wallets) => {
    evmWallets.value = wallets;
    const preferred = loadPreference("evm-wallet");
    const match = wallets.find((wallet) => wallet.info.rdns === preferred);
    if (match && !evmWallet.value) void connectEvm(match, true);
  });
  discoverSolanaWallets((wallets) => {
    solanaWallets.value = wallets;
    const preferred = loadPreference("solana-wallet");
    const match = wallets.find((wallet) => wallet.name === preferred);
    if (match && !solanaWallet.value) void connectSolana(match, true);
  });

  // Anything that changes what would be burned invalidates acknowledgement of the reviewed route.
  effect(() => {
    void currentRouteKey.value;
    acknowledgedWarnings.value = false;
  });

  // Re-inspect when the token or the Base account changes (the balance shown depends on both).
  let tokenTimer: number | null = null;
  effect(() => {
    void tokenInput.value;
    void evmAccount.value;
    if (tokenTimer !== null) window.clearTimeout(tokenTimer);
    tokenTimer = window.setTimeout(() => void runInspection(), 350);
  });

  const queryTx = new URLSearchParams(window.location.search).get("tx");
  if (queryTx) void track(queryTx);

  void findUpgradedComponents(getBaseClient(), getSolanaRpc())
    .then((changed) => (upgradedComponents.value = changed))
    .catch(() => undefined);
}
