import { address } from "@solana/kit";
import { base } from "viem/chains";

// Base mainnet → Solana mainnet. Addresses match base/bridge's base/deployments/base_mainnet.json.

const env = import.meta.env ?? {};

export const NETWORK = {
  base: {
    chain: base,
    bridge: "0x3eff766C76a1be2Ce1aCF2B69c78bCae257D5188",
    factory: "0xDD56781d0509650f8C2981231B6C917f2d5d7dF2",
    /** The CrossChainERC20 that represents native SOL on Base. */
    solWrapper: "0x311935Cd80B76769bF2ecC9D8Ab7635b2139cf82",
    /**
     * Every Base read, including historical `eth_call` for proofs, so it must serve old blocks.
     * Proofs are safe from any endpoint: each is checked against the output root on Solana before signing.
     */
    rpcUrl: env.VITE_BASE_RPC_URL?.trim() || "https://mainnet.base.org",
    explorer: "https://basescan.org",
    /** Average block time, used only for ETAs. */
    blockTimeSeconds: 2
  },
  solana: {
    bridgeProgram: address("HNCne2FkVaNghhjKXapxJzPaBvAKDG1Ge3gqhZyfVWLM"),
    /** Wallet Standard chain identifier. */
    chain: "solana:mainnet",
    /**
     * A free, keyless endpoint that serves browser pages (api.mainnet-beta.solana.com refuses them, and
     * drpc's Solana is paid-only). Public endpoints can be slow under load; set VITE_SOLANA_RPC_URL in production.
     */
    rpcUrl: env.VITE_SOLANA_RPC_URL?.trim() || "https://solana-rpc.publicnode.com"
  }
} as const;

export function solanaExplorerTx(signature: string): string {
  return `https://explorer.solana.com/tx/${signature}`;
}

export function solanaExplorerAccount(account: string): string {
  return `https://explorer.solana.com/address/${account}`;
}

export function baseExplorerTx(hash: string): string {
  return `${NETWORK.base.explorer}/tx/${hash}`;
}
