import {
  createPublicClient,
  decodeEventLog,
  fallback,
  getAddress,
  http,
  parseAbi,
  TransactionReceiptNotFoundError,
  type Address,
  type Hex,
  type PublicClient
} from "viem";

import { NETWORK } from "../config";

export const ERC20_WRAPPER_ABI = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function bridge() view returns (address)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function remoteToken() view returns (bytes32)"
]);

export const FACTORY_ABI = parseAbi(["function isCrossChainErc20(address token) view returns (bool)"]);

export const BRIDGE_ABI = [
  ...parseAbi([
    "function paused() view returns (bool)",
    "function generateProof(uint64 leafIndex) view returns (bytes32[] proof)",
    "event MessageInitiated(bytes32 indexed messageHash, bytes32 indexed mmrRoot, (uint64 nonce, address sender, bytes data) message)",
    "error Paused()",
    "error InvalidMsgValue()",
    "error IncorrectRemoteToken()",
    "error WrappedSplRouteNotRegistered()",
    "error ZeroAmount()",
    "error SerializedMessageTooBig()"
  ]),
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
  }
] as const;

function makeClient(urls: string[]): PublicClient {
  return createPublicClient({
    chain: NETWORK.base.chain,
    batch: { multicall: true },
    transport: fallback(
      urls.map((url) => http(url, { retryCount: 1, retryDelay: 600, timeout: 15_000 })),
      { retryCount: 1 }
    )
  }) as PublicClient;
}

let latestClient: PublicClient | null = null;
let archiveClient: PublicClient | null = null;

export function getBaseClient(): PublicClient {
  latestClient ??= makeClient(NETWORK.base.rpcUrls);
  return latestClient;
}

/** Historical `eth_call` (proof generation) needs an archive-capable endpoint. */
export function getBaseArchiveClient(): PublicClient {
  archiveClient ??= makeClient(NETWORK.base.archiveRpcUrls);
  return archiveClient;
}

export type WrapperInfo = {
  address: Address;
  official: boolean;
  remoteToken: Hex;
  decimals: number;
  symbol: string;
  name: string;
  bridge: Address;
  balance: bigint | null;
  bridgePaused: boolean;
};

export async function readWrapper(client: PublicClient, token: Address, holder: Address | null): Promise<WrapperInfo> {
  const code = await client.getCode({ address: token });
  if (!code || code === "0x") throw new Error("There is no contract at that Base address.");

  const [official, bridgePaused] = await client.multicall({
    allowFailure: false,
    contracts: [
      { address: NETWORK.base.factory, abi: FACTORY_ABI, functionName: "isCrossChainErc20", args: [token] },
      { address: NETWORK.base.bridge, abi: BRIDGE_ABI, functionName: "paused" }
    ]
  });
  if (!official) {
    return { address: token, official: false, remoteToken: "0x", decimals: 0, symbol: "", name: "", bridge: "0x0000000000000000000000000000000000000000", balance: null, bridgePaused };
  }

  const wrapper = { address: token, abi: ERC20_WRAPPER_ABI } as const;
  const [remoteToken, decimals, symbol, name, bridge, balance] = await client.multicall({
    allowFailure: false,
    contracts: [
      { ...wrapper, functionName: "remoteToken" },
      { ...wrapper, functionName: "decimals" },
      { ...wrapper, functionName: "symbol" },
      { ...wrapper, functionName: "name" },
      { ...wrapper, functionName: "bridge" },
      { ...wrapper, functionName: "balanceOf", args: [holder ?? "0x0000000000000000000000000000000000000000"] }
    ]
  });
  return { address: token, official: true, remoteToken, decimals, symbol, name, bridge: getAddress(bridge), balance: holder ? balance : null, bridgePaused };
}

export type BridgeEvent = { messageHash: Hex; nonce: bigint; sender: Hex; data: Hex };

export type BaseTxLookup =
  | { status: "not-found" }
  | { status: "reverted"; blockNumber: bigint }
  | { status: "no-bridge-event"; blockNumber: bigint }
  | { status: "multiple-bridge-events"; blockNumber: bigint }
  | { status: "found"; blockNumber: bigint; from: Address; event: BridgeEvent };

export async function lookupBridgeTransaction(client: PublicClient, hash: Hex): Promise<BaseTxLookup> {
  let receipt;
  try {
    receipt = await client.getTransactionReceipt({ hash });
  } catch (error) {
    if (isReceiptNotFound(error)) return { status: "not-found" };
    throw error;
  }
  if (receipt.status === "reverted") return { status: "reverted", blockNumber: receipt.blockNumber };

  const events: BridgeEvent[] = [];
  for (const log of receipt.logs) {
    if (getAddress(log.address) !== getAddress(NETWORK.base.bridge)) continue;
    try {
      const decoded = decodeEventLog({ abi: BRIDGE_ABI, topics: log.topics, data: log.data });
      if (decoded.eventName === "MessageInitiated") {
        const { messageHash, message } = decoded.args;
        events.push({ messageHash, nonce: message.nonce, sender: message.sender, data: message.data });
      }
    } catch {
      // Other bridge events are irrelevant here.
    }
  }
  if (events.length === 0) return { status: "no-bridge-event", blockNumber: receipt.blockNumber };
  if (events.length > 1) return { status: "multiple-bridge-events", blockNumber: receipt.blockNumber };
  return { status: "found", blockNumber: receipt.blockNumber, from: getAddress(receipt.from), event: events[0] };
}

function isReceiptNotFound(error: unknown): boolean {
  for (let current = error as { cause?: unknown; name?: string } | undefined, depth = 0; current && depth < 8; current = current.cause as never, depth++) {
    if (current instanceof TransactionReceiptNotFoundError || current.name === "TransactionReceiptNotFoundError") return true;
  }
  return false;
}

export async function generateProof(client: PublicClient, nonce: bigint, atBlock: bigint): Promise<readonly Hex[]> {
  return client.readContract({ address: NETWORK.base.bridge, abi: BRIDGE_ABI, functionName: "generateProof", args: [nonce], blockNumber: atBlock });
}
