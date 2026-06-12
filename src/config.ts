import { base, baseSepolia, type Chain } from "viem/chains";

export type AppConfig = {
  env: "mainnet" | "testnet";
  label: string;
  baseChain: Chain;
  baseBridge: `0x${string}`;
  baseFactory: `0x${string}`;
  baseRpcUrls: string[];
  solanaRpcUrl: string;
  solanaBridgeProgram: string;
};


function rpcUrls(primary: string, fallbackUrl: string): string[] {
  const raw = primary.trim();
  const urls = (raw || fallbackUrl)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return [...new Set(urls)];
}

const ENVIRONMENTS: Record<AppConfig["env"], AppConfig> = {
  mainnet: {
    env: "mainnet",
    label: "Base Mainnet → Solana Mainnet",
    baseChain: base,
    baseBridge: "0x3eff766C76a1be2Ce1aCF2B69c78bCae257D5188",
    baseFactory: "0xDD56781d0509650f8C2981231B6C917f2d5d7dF2",
    baseRpcUrls: rpcUrls(import.meta.env.VITE_BASE_RPC_URLS || import.meta.env.VITE_BASE_RPC_URL || "", "https://mainnet.base.org"),
    solanaRpcUrl: import.meta.env.VITE_SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",
    solanaBridgeProgram: "HNCne2FkVaNghhjKXapxJzPaBvAKDG1Ge3gqhZyfVWLM"
  },
  testnet: {
    env: "testnet",
    label: "Base Sepolia → Solana Devnet",
    baseChain: baseSepolia,
    baseBridge: "0x01824a90d32A69022DdAEcC6C5C14Ed08dB4EB9B",
    baseFactory: "0x488EB7F7cb2568e31595D48cb26F63963Cc7565D",
    baseRpcUrls: rpcUrls(import.meta.env.VITE_BASE_RPC_URLS || import.meta.env.VITE_BASE_RPC_URL || "", "https://sepolia.base.org"),
    solanaRpcUrl: import.meta.env.VITE_SOLANA_RPC_URL || "https://api.devnet.solana.com",
    solanaBridgeProgram: "7c6mteAcTXaQ1MFBCrnuzoZVTTAEfZwa6wgy4bqX3KXC"
  }
};

const requestedEnv = String(import.meta.env.VITE_BRIDGE_ENV || "mainnet").toLowerCase();
if (requestedEnv !== "mainnet" && requestedEnv !== "testnet") {
  throw new Error(`Unsupported VITE_BRIDGE_ENV "${requestedEnv}". Use "mainnet" or "testnet".`);
}

export const CONFIG = ENVIRONMENTS[requestedEnv as AppConfig["env"]];

export const ERC20_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }]
  },
  {
    type: "function",
    name: "bridge",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }]
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }]
  },
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }]
  },
  {
    type: "function",
    name: "remoteToken",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bytes32" }]
  }
] as const;

export const FACTORY_ABI = [
  {
    type: "function",
    name: "isCrossChainErc20",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [{ type: "bool" }]
  }
] as const;

export const BRIDGE_ABI = [
  {
    type: "function",
    name: "bridgeToken",
    stateMutability: "payable",
    inputs: [
      {
        name: "transfer",
        type: "tuple",
        components: [
          { name: "localToken", type: "address" },
          { name: "remoteToken", type: "bytes32" },
          { name: "to", type: "bytes32" },
          { name: "remoteAmount", type: "uint64" }
        ]
      },
      {
        name: "ixs",
        type: "tuple[]",
        components: [
          { name: "programId", type: "bytes32" },
          { name: "serializedAccounts", type: "bytes[]" },
          { name: "data", type: "bytes" }
        ]
      }
    ],
    outputs: []
  },
  {
    type: "function",
    name: "generateProof",
    stateMutability: "view",
    inputs: [{ name: "leafIndex", type: "uint64" }],
    outputs: [{ name: "proof", type: "bytes32[]" }]
  },
  {
    type: "event",
    name: "MessageInitiated",
    inputs: [
      { indexed: true, name: "messageHash", type: "bytes32" },
      { indexed: true, name: "mmrRoot", type: "bytes32" },
      {
        indexed: false,
        name: "message",
        type: "tuple",
        components: [
          { name: "nonce", type: "uint64" },
          { name: "sender", type: "address" },
          { name: "data", type: "bytes" }
        ]
      }
    ]
  }
] as const;
