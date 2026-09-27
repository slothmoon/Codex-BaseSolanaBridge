import { address, type Address } from "@solana/kit";
import { SolanaSignTransaction, type SolanaSignTransactionFeature } from "@solana/wallet-standard-features";
import { getWallets } from "@wallet-standard/app";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import {
  StandardConnect,
  StandardDisconnect,
  StandardEvents,
  type StandardConnectFeature,
  type StandardDisconnectFeature,
  type StandardEventsFeature
} from "@wallet-standard/features";

import { NETWORK } from "../config";
import type { SolanaSigner } from "../core/claim";

export type SolanaWallet = {
  name: string;
  icon: string;
  wallet: Wallet;
};

type Features = StandardConnectFeature & Partial<StandardDisconnectFeature & StandardEventsFeature> & SolanaSignTransactionFeature;

/** Wallets that can connect and sign transactions for the configured Solana chain. */
export function isUsableWallet(wallet: Wallet): boolean {
  return (
    StandardConnect in wallet.features &&
    SolanaSignTransaction in wallet.features &&
    wallet.chains.some((chain) => chain === NETWORK.solana.chain)
  );
}

export function discoverSolanaWallets(onChange: (wallets: SolanaWallet[]) => void): () => void {
  const api = getWallets();
  const emit = () => onChange(api.get().filter(isUsableWallet).map((wallet) => ({ name: wallet.name, icon: wallet.icon, wallet })));
  emit();
  const offRegister = api.on("register", emit);
  const offUnregister = api.on("unregister", emit);
  return () => {
    offRegister();
    offUnregister();
  };
}

function features(wallet: Wallet): Features {
  return wallet.features as unknown as Features;
}

function pickAccount(accounts: readonly WalletAccount[]): WalletAccount | null {
  return accounts.find((account) => account.chains.includes(NETWORK.solana.chain)) ?? accounts[0] ?? null;
}

export async function connectSolanaWallet(wallet: Wallet, silent = false): Promise<WalletAccount | null> {
  const { accounts } = await features(wallet)[StandardConnect].connect({ silent });
  return pickAccount(accounts);
}

export async function disconnectSolanaWallet(wallet: Wallet): Promise<void> {
  await features(wallet)[StandardDisconnect]?.disconnect();
}

export function watchSolanaWallet(wallet: Wallet, onAccount: (account: WalletAccount | null) => void): () => void {
  const events = features(wallet)[StandardEvents];
  if (!events) return () => undefined;
  return events.on("change", ({ accounts }) => {
    if (accounts) onAccount(pickAccount(accounts));
  });
}

/** Adapts a Wallet Standard account into the minimal signer the claim flow needs. */
export function toSolanaSigner(wallet: Wallet, account: WalletAccount): SolanaSigner {
  const feature = features(wallet)[SolanaSignTransaction];
  return {
    address: address(account.address) as Address,
    supportsV1: feature.supportedTransactionVersions.includes(1),
    async signTransaction(wire) {
      const [output] = await feature.signTransaction({ account, transaction: wire, chain: NETWORK.solana.chain });
      if (!output?.signedTransaction) throw new Error("The wallet did not return a signed transaction.");
      return output.signedTransaction;
    }
  };
}
