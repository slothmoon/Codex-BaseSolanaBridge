import { PublicKey } from "@solana/web3.js";
import { getAddress } from "viem";

import { CONFIG } from "./config";
import { state, type SolanaProvider } from "./shared";
import { $, invalidateBurnValidation, setStatus, short } from "./ui";

let activeSolanaProvider: SolanaProvider | null = null;

export async function connectBase(): Promise<void> {
  if (!window.ethereum) throw new Error("Install a Base-compatible wallet such as Coinbase Wallet or MetaMask.");
  const accounts = (await window.ethereum.request({ method: "eth_requestAccounts" })) as string[];
  if (!accounts[0]) throw new Error("The Base wallet did not return an account.");
  setBaseAccount(accounts[0]);
  await ensureBaseNetwork();
}

export async function restoreBaseConnection(): Promise<void> {
  if (!window.ethereum) return;
  try {
    const accounts = (await window.ethereum.request({ method: "eth_accounts" })) as string[];
    if (accounts[0]) setBaseAccount(accounts[0]);
  } catch {
    // Silent restore is best effort. The user can still connect manually.
  }
}

export function watchBaseAccountChanges(): void {
  window.ethereum?.on?.("accountsChanged", (accounts) => {
    if (accounts[0]) {
      setBaseAccount(accounts[0]);
      return;
    }
    if (state.evmAccount) invalidateBurnValidation();
    state.evmAccount = "";
    $("baseWallet").textContent = "Base wallet not connected.";
    $("connectBase").textContent = "Connect Base wallet";
  });
}

export async function connectSolana(): Promise<void> {
  const provider = getSolanaProvider();
  if (!provider) throw new Error("Install or unlock a Solana wallet such as Phantom or Solflare.");
  setStatus("Opening your Solana wallet...");
  const result = await provider.connect();
  const publicKey = getSolanaPublicKey(provider, result);
  if (!publicKey) throw new Error("The Solana wallet connected but did not provide its public key.");
  setSolanaAccount(publicKey, provider);
  setStatus("Solana wallet connected.");
}

export function restoreSolanaConnection(): void {
  syncSolanaConnection();
}

export function watchSolanaAccountChanges(): void {
  for (const provider of getAvailableSolanaProviders()) {
    provider.on?.("accountChanged", (value) => {
      const publicKey = normalizeSolanaPublicKey(value) || getSolanaPublicKey(provider);
      if (publicKey) {
        setSolanaAccount(publicKey, provider);
      } else if (activeSolanaProvider === provider) {
        activeSolanaProvider = null;
        syncSolanaConnection();
      }
    });

    provider.on?.("connect", (value) => {
      const publicKey = normalizeSolanaPublicKey(value) || getSolanaPublicKey(provider);
      if (publicKey) setSolanaAccount(publicKey, provider);
    });

    provider.on?.("disconnect", () => {
      if (activeSolanaProvider === provider) activeSolanaProvider = null;
      syncSolanaConnection();
    });
  }

  window.addEventListener("focus", syncSolanaConnection);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") syncSolanaConnection();
  });
  window.setInterval(syncSolanaConnection, 2_000);
}

export async function ensureBaseNetwork(): Promise<void> {
  if (!window.ethereum) return;
  const chainId = `0x${CONFIG.baseChain.id.toString(16)}`;
  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId }]
    });
  } catch (error) {
    if (getProviderErrorCode(error) !== 4902) throw error;
    await window.ethereum.request({
      method: "wallet_addEthereumChain",
      params: [{
        chainId,
        chainName: CONFIG.baseChain.name,
        nativeCurrency: CONFIG.baseChain.nativeCurrency,
        rpcUrls: CONFIG.baseChain.rpcUrls.default.http,
        blockExplorerUrls: CONFIG.baseChain.blockExplorers?.default ? [CONFIG.baseChain.blockExplorers.default.url] : undefined
      }]
    });
  }
}

export function getSolanaProvider(): SolanaProvider | null {
  if (activeSolanaProvider?.publicKey) return activeSolanaProvider;
  const providers = getAvailableSolanaProviders();
  return providers.find((provider) => Boolean(provider.publicKey)) || activeSolanaProvider || providers[0] || null;
}

function setBaseAccount(account: string): void {
  const nextAccount = getAddress(account);
  if (state.evmAccount !== nextAccount) invalidateBurnValidation();
  state.evmAccount = nextAccount;
  $("baseWallet").textContent = `Base: ${short(nextAccount)}`;
  $("connectBase").textContent = "Base wallet connected";
}

function getAvailableSolanaProviders(): SolanaProvider[] {
  const providers = [window.solflare, window.solana].filter((provider): provider is SolanaProvider => Boolean(provider));
  return providers.filter((provider, index) => providers.indexOf(provider) === index);
}

function getSolanaPublicKey(provider: SolanaProvider, result?: { publicKey?: PublicKey } | void): string {
  return result?.publicKey?.toBase58() || provider.publicKey?.toBase58() || "";
}

function normalizeSolanaPublicKey(value: unknown): string {
  if (!value) return "";
  if (value instanceof PublicKey) return value.toBase58();
  if (typeof value === "string") {
    try {
      return new PublicKey(value).toBase58();
    } catch {
      return "";
    }
  }
  const candidate = value as { toBase58?: () => string };
  try {
    return candidate.toBase58?.() || "";
  } catch {
    return "";
  }
}

function setSolanaAccount(publicKey: string, provider?: SolanaProvider): void {
  const normalized = new PublicKey(publicKey).toBase58();
  const changed = state.solanaAccount !== normalized;
  const hadValidatedPreview = Boolean(state.validatedBurnKey);

  if (changed) invalidateBurnValidation();
  state.solanaAccount = normalized;
  if (provider) activeSolanaProvider = provider;
  $("solanaWallet").textContent = `Solana: ${short(normalized)}`;
  $("connectSolana").textContent = "Solana wallet connected";

  if (changed && hadValidatedPreview) {
    $("derivedBox").textContent = "Solana wallet changed. Validate and preview again before burning.";
  }
}

function clearSolanaAccount(): void {
  if (state.solanaAccount) invalidateBurnValidation();
  state.solanaAccount = "";
  activeSolanaProvider = null;
  $("solanaWallet").textContent = "Solana wallet not connected.";
  $("connectSolana").textContent = "Connect Solana wallet";
}

function syncSolanaConnection(): void {
  const providers = getAvailableSolanaProviders();
  const activeKey = activeSolanaProvider ? getSolanaPublicKey(activeSolanaProvider) : "";
  if (activeKey) {
    setSolanaAccount(activeKey, activeSolanaProvider || undefined);
    return;
  }

  const connected = providers.find((provider) => Boolean(getSolanaPublicKey(provider)));
  if (connected) {
    setSolanaAccount(getSolanaPublicKey(connected), connected);
    return;
  }

  if (state.solanaAccount) clearSolanaAccount();
}

function getProviderErrorCode(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? Number((error as { code: unknown }).code)
    : undefined;
}
