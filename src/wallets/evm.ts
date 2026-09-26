import { createWalletClient, custom, getAddress, numberToHex, type Address, type Hex } from "viem";

import { NETWORK } from "../config";
import { BRIDGE_ABI } from "../chain/base";

export type Eip1193Provider = {
  request(args: { method: string; params?: unknown[] | Record<string, unknown> }): Promise<unknown>;
  on?(event: string, listener: (...args: never[]) => void): void;
  removeListener?(event: string, listener: (...args: never[]) => void): void;
};

export type EvmWalletInfo = { uuid: string; name: string; icon: string; rdns: string };
export type EvmWallet = { info: EvmWalletInfo; provider: Eip1193Provider };

/**
 * EIP-6963 multi-wallet discovery, so users with several extensions pick one explicitly instead of
 * whichever extension won the race for `window.ethereum`.
 */
export function discoverEvmWallets(onChange: (wallets: EvmWallet[]) => void): () => void {
  const wallets = new Map<string, EvmWallet>();
  const emit = () => onChange([...wallets.values()]);
  const onAnnounce = (event: Event) => {
    const detail = (event as CustomEvent<EvmWallet>).detail;
    if (!detail?.info?.uuid || !detail.provider) return;
    wallets.set(detail.info.uuid, { info: { ...detail.info, icon: safeIcon(detail.info.icon) }, provider: detail.provider });
    emit();
  };
  window.addEventListener("eip6963:announceProvider", onAnnounce);
  window.dispatchEvent(new Event("eip6963:requestProvider"));

  // Older wallets only inject window.ethereum.
  const fallbackTimer = window.setTimeout(() => {
    const injected = (window as { ethereum?: Eip1193Provider }).ethereum;
    if (wallets.size === 0 && injected) {
      wallets.set("injected", { info: { uuid: "injected", name: "Browser wallet", icon: "", rdns: "injected" }, provider: injected });
      emit();
    }
  }, 400);

  return () => {
    window.removeEventListener("eip6963:announceProvider", onAnnounce);
    window.clearTimeout(fallbackTimer);
  };
}

function safeIcon(icon: string): string {
  // Only inline data images are rendered; the CSP blocks remote images anyway.
  return /^data:image\/(png|jpeg|jpg|gif|webp|svg\+xml);/i.test(icon) ? icon : "";
}

const chainIdHex = numberToHex(NETWORK.base.chain.id);

export async function requestEvmAccount(wallet: EvmWallet, silent = false): Promise<Address | null> {
  const accounts = (await wallet.provider.request({ method: silent ? "eth_accounts" : "eth_requestAccounts" })) as string[];
  return accounts?.[0] ? getAddress(accounts[0]) : null;
}

export async function readEvmChainId(wallet: EvmWallet): Promise<number | null> {
  try {
    return Number(await wallet.provider.request({ method: "eth_chainId" }));
  } catch {
    return null;
  }
}

export async function switchToBase(wallet: EvmWallet): Promise<void> {
  try {
    await wallet.provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainIdHex }] });
  } catch (error) {
    if (Number((error as { code?: unknown })?.code) !== 4902) throw error;
    const chain = NETWORK.base.chain;
    await wallet.provider.request({
      method: "wallet_addEthereumChain",
      params: [{ chainId: chainIdHex, chainName: chain.name, nativeCurrency: chain.nativeCurrency, rpcUrls: chain.rpcUrls.default.http, blockExplorerUrls: [NETWORK.base.explorer] }]
    });
  }
}

export function watchEvmWallet(wallet: EvmWallet, handlers: { accounts: (account: Address | null) => void; chain: (chainId: number) => void }): () => void {
  const onAccounts = (accounts: string[]) => handlers.accounts(accounts?.[0] ? getAddress(accounts[0]) : null);
  const onChain = (chainId: string) => handlers.chain(Number(chainId));
  wallet.provider.on?.("accountsChanged", onAccounts as never);
  wallet.provider.on?.("chainChanged", onChain as never);
  return () => {
    wallet.provider.removeListener?.("accountsChanged", onAccounts as never);
    wallet.provider.removeListener?.("chainChanged", onChain as never);
  };
}

/** Sends the exact, already-simulated burn. viem refuses if the wallet is on the wrong chain. */
export async function sendBurn(wallet: EvmWallet, account: Address, transfer: { localToken: Address; remoteToken: Hex; to: Hex; remoteAmount: bigint }): Promise<Hex> {
  const client = createWalletClient({ chain: NETWORK.base.chain, transport: custom(wallet.provider), account });
  return client.writeContract({ address: NETWORK.base.bridge, abi: BRIDGE_ABI, functionName: "bridgeToken", args: [transfer, []], value: 0n, chain: NETWORK.base.chain, account });
}
