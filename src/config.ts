import { address, type Address } from "@solana/kit";
import { base, baseSepolia, type Chain } from "viem/chains";

export type NetworkId = "mainnet" | "testnet";

export type NetworkConfig = {
  id: NetworkId;
  label: string;
  base: {
    chain: Chain;
    bridge: `0x${string}`;
    factory: `0x${string}`;
    /** The official CrossChainERC20 that represents native SOL on Base. */
    solWrapper: `0x${string}`;
    /** Used for every latest-state read. Tried in order. */
    rpcUrls: string[];
    /** Used for historical `eth_call` (proof generation). Must be archive-capable. Tried in order. */
    archiveRpcUrls: string[];
    explorer: string;
    /** Average block time, used only for ETAs. */
    blockTimeSeconds: number;
  };
  solana: {
    bridgeProgram: Address;
    /** Wallet Standard chain identifier. */
    chain: "solana:mainnet" | "solana:devnet";
    rpcUrls: string[];
    explorerQuery: string;
  };
};

function withOverride(override: string | undefined, defaults: string[]): string[] {
  const trimmed = override?.trim();
  return trimmed ? [trimmed, ...defaults.filter((url) => url !== trimmed)] : defaults;
}

const env = import.meta.env ?? {};

export const NETWORKS: Record<NetworkId, NetworkConfig> = {
  mainnet: {
    id: "mainnet",
    label: "Base → Solana",
    base: {
      chain: base,
      bridge: "0x3eff766C76a1be2Ce1aCF2B69c78bCae257D5188",
      factory: "0xDD56781d0509650f8C2981231B6C917f2d5d7dF2",
      solWrapper: "0x311935Cd80B76769bF2ecC9D8Ab7635b2139cf82",
      // Latest-state reads feed the burn decision, so only Base-operated endpoints plus publicnode.
      rpcUrls: withOverride(env.VITE_BASE_RPC_URL, ["https://mainnet.base.org", "https://developer-access-mainnet.base.org", "https://base-rpc.publicnode.com"]),
      // Historical eth_call for proofs. A third-party fallback is safe here because every proof is
      // verified against the on-chain Solana output root before anything is signed.
      archiveRpcUrls: withOverride(env.VITE_BASE_ARCHIVE_RPC_URL ?? env.VITE_BASE_RPC_URL, [
        "https://mainnet.base.org",
        "https://developer-access-mainnet.base.org",
        "https://base.gateway.tenderly.co"
      ]),
      explorer: "https://basescan.org",
      blockTimeSeconds: 2
    },
    solana: {
      bridgeProgram: address("HNCne2FkVaNghhjKXapxJzPaBvAKDG1Ge3gqhZyfVWLM"),
      chain: "solana:mainnet",
      rpcUrls: withOverride(env.VITE_SOLANA_RPC_URL, ["https://solana-rpc.publicnode.com", "https://api.mainnet-beta.solana.com"]),
      explorerQuery: ""
    }
  },
  testnet: {
    id: "testnet",
    label: "Base Sepolia → Solana Devnet",
    base: {
      chain: baseSepolia,
      bridge: "0x01824a90d32A69022DdAEcC6C5C14Ed08dB4EB9B",
      factory: "0x488EB7F7cb2568e31595D48cb26F63963Cc7565D",
      solWrapper: "0xCace0c896714DaF7098FFD8CC54aFCFe0338b4BC",
      rpcUrls: withOverride(env.VITE_BASE_RPC_URL, ["https://sepolia.base.org", "https://base-sepolia-rpc.publicnode.com"]),
      archiveRpcUrls: withOverride(env.VITE_BASE_ARCHIVE_RPC_URL ?? env.VITE_BASE_RPC_URL, ["https://sepolia.base.org"]),
      explorer: "https://sepolia.basescan.org",
      blockTimeSeconds: 2
    },
    solana: {
      bridgeProgram: address("7c6mteAcTXaQ1MFBCrnuzoZVTTAEfZwa6wgy4bqX3KXC"),
      chain: "solana:devnet",
      rpcUrls: withOverride(env.VITE_SOLANA_RPC_URL, ["https://api.devnet.solana.com"]),
      explorerQuery: "?cluster=devnet"
    }
  }
};

function resolveNetwork(): NetworkConfig {
  const requested = String(env.VITE_BRIDGE_ENV || "mainnet").toLowerCase();
  if (requested !== "mainnet" && requested !== "testnet") {
    throw new Error(`Unsupported VITE_BRIDGE_ENV "${requested}". Use "mainnet" or "testnet".`);
  }
  return NETWORKS[requested];
}

export const NETWORK = resolveNetwork();

export function solanaExplorerTx(signature: string): string {
  return `https://explorer.solana.com/tx/${signature}${NETWORK.solana.explorerQuery}`;
}

export function solanaExplorerAccount(account: string): string {
  return `https://explorer.solana.com/address/${account}${NETWORK.solana.explorerQuery}`;
}

export function baseExplorerTx(hash: string): string {
  return `${NETWORK.base.explorer}/tx/${hash}`;
}
