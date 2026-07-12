import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import {
  createPublicClient,
  custom,
  fallback,
  http,
  type Address,
  type Hex
} from "viem";

import { CONFIG } from "./config";
import type { MintInfo, ParsedTransfer } from "./solana";

export type EthereumProvider = {
  request(args: { method: string; params?: unknown[] | Record<string, unknown> }): Promise<unknown>;
  on?(event: "accountsChanged", listener: (accounts: string[]) => void): void;
  on?(event: "chainChanged", listener: (chainId: string) => void): void;
};

export type SolanaProvider = {
  isPhantom?: boolean;
  isSolflare?: boolean;
  isConnected?: boolean;
  publicKey?: PublicKey;
  connect(input?: { onlyIfTrusted?: boolean }): Promise<{ publicKey?: PublicKey } | void>;
  signAndSendTransaction?(transaction: Transaction): Promise<{ signature: string }>;
  signTransaction?(transaction: Transaction): Promise<Transaction | void>;
  on?(event: "accountChanged" | "connect" | "disconnect", listener: (...args: unknown[]) => void): void;
};

declare global {
  interface Window {
    ethereum?: EthereumProvider;
    solana?: SolanaProvider;
    solflare?: SolanaProvider;
  }
}

export type ReturnDetails = {
  localToken: Address;
  symbol: string;
  decimals: number;
  remoteToken: Hex;
  remoteMint: PublicKey;
  mintInfo: MintInfo;
  recipientTokenAccount: PublicKey;
  tokenVault: PublicKey;
  wrapperBalance: bigint;
  vaultBalance: bigint;
  amount?: bigint;
};

export type BridgeStatus = {
  status: "waiting_for_base_tx" | "not_bridge_tx" | "waiting_for_root" | "ready_to_claim" | "proof_created" | "claimed";
  humanStatus: string;
  txHash: Hex;
  messageHash?: Hex;
  messageNonce?: bigint;
  messageData?: Hex;
  sender?: Hex;
  baseBlockNumber?: bigint;
  solanaBaseBlockNumber?: bigint;
  nextEligibleRootBlock?: bigint;
  rootBlocksBehind?: bigint;
  bridgePaused?: boolean;
  incomingMessage?: PublicKey;
  transfer?: ParsedTransfer;
  displayAmount?: string;
};

export const STORAGE_KEY = "base-solana-bridge:last-base-tx";

export const solana = new Connection(CONFIG.solanaRpcUrl, "confirmed");

export const state = {
  evmAccount: "" as Address | "",
  baseReady: false,
  solanaAccount: "",
  currentTxHash: "" as Hex | "",
  currentStatus: null as BridgeStatus | null,
  validatedBurnKey: "",
  actionInFlight: false
};

export function getBaseClient() {
  const publicRpc = http(CONFIG.baseRpcUrl, { retryCount: 1, retryDelay: 500, timeout: 15_000 });
  const transport = window.ethereum && state.baseReady
    ? fallback([custom(window.ethereum), publicRpc], { retryCount: 2, retryDelay: 750 })
    : publicRpc;
  return createPublicClient({
    chain: CONFIG.baseChain,
    transport
  });
}
