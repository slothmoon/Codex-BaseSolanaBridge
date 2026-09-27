import { address } from "@solana/kit";
import { base } from "viem/chains";

// Base mainnet → Solana mainnet. Addresses match base/bridge's base/deployments/base_mainnet.json.

function withOverride(override: string | undefined, defaults: string[]): string[] {
  const trimmed = override?.trim();
  return trimmed ? [trimmed, ...defaults.filter((url) => url !== trimmed)] : defaults;
}

const env = import.meta.env ?? {};

export const NETWORK = {
  base: {
    chain: base,
    bridge: "0x3eff766C76a1be2Ce1aCF2B69c78bCae257D5188",
    factory: "0xDD56781d0509650f8C2981231B6C917f2d5d7dF2",
    /** The CrossChainERC20 that represents native SOL on Base. */
    solWrapper: "0x311935Cd80B76769bF2ecC9D8Ab7635b2139cf82",
    /** Used for every latest-state read. Tried in order. Latest-state reads feed the burn decision, so only Base-operated endpoints plus publicnode. */
    rpcUrls: withOverride(env.VITE_BASE_RPC_URL, ["https://mainnet.base.org", "https://developer-access-mainnet.base.org", "https://base-rpc.publicnode.com"]),
    /**
     * Used for historical `eth_call` (proof generation); must be archive-capable. Tried in order. A
     * third-party fallback is safe here because every proof is verified against the on-chain Solana
     * output root before anything is signed.
     */
    archiveRpcUrls: withOverride(env.VITE_BASE_ARCHIVE_RPC_URL ?? env.VITE_BASE_RPC_URL, [
      "https://mainnet.base.org",
      "https://developer-access-mainnet.base.org",
      "https://base.gateway.tenderly.co"
    ]),
    explorer: "https://basescan.org",
    /** Average block time, used only for ETAs. */
    blockTimeSeconds: 2
  },
  solana: {
    bridgeProgram: address("HNCne2FkVaNghhjKXapxJzPaBvAKDG1Ge3gqhZyfVWLM"),
    /** Wallet Standard chain identifier. */
    chain: "solana:mainnet",
    rpcUrls: withOverride(env.VITE_SOLANA_RPC_URL, ["https://solana-rpc.publicnode.com", "https://api.mainnet-beta.solana.com"])
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
