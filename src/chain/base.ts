import {
  createPublicClient,
  decodeEventLog,
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

let client: PublicClient | null = null;

/** One client for every Base read, current and historical. */
export function getBaseClient(): PublicClient {
  client ??= createPublicClient({
    chain: NETWORK.base.chain,
    batch: { multicall: true },
    transport: http(NETWORK.base.rpcUrl, { retryCount: 1, retryDelay: 600, timeout: 15_000 })
  }) as PublicClient;
  return client;
}

export type WrapperInfo = {
  address: Address;
  official: boolean;
  remoteToken: Hex;
  decimals: number;
  symbol: string;
  name: string;
  balance: bigint | null;
  bridgePaused: boolean;
};

/**
 * One Base call: the factory check, the bridge's pause flag and the wrapper's details. For an address
 * that isn't a bridge wrapper the detail reads simply fail, and only the factory check matters.
 */
export async function readWrapper(client: PublicClient, token: Address, holder: Address | null): Promise<WrapperInfo> {
  const wrapper = { address: token, abi: ERC20_WRAPPER_ABI } as const;
  const [official, paused, remoteToken, decimals, symbol, name, balance] = await client.multicall({
    allowFailure: true,
    contracts: [
      { address: NETWORK.base.factory, abi: FACTORY_ABI, functionName: "isCrossChainErc20", args: [token] },
      { address: NETWORK.base.bridge, abi: BRIDGE_ABI, functionName: "paused" },
      { ...wrapper, functionName: "remoteToken" },
      { ...wrapper, functionName: "decimals" },
      { ...wrapper, functionName: "symbol" },
      { ...wrapper, functionName: "name" },
      { ...wrapper, functionName: "balanceOf", args: [holder ?? "0x0000000000000000000000000000000000000000"] }
    ]
  });
  if (official.status !== "success" || paused.status !== "success") throw new Error("Could not read the Base bridge contracts. Try again in a moment.");
  if (!official.result) {
    return { address: token, official: false, remoteToken: "0x", decimals: 0, symbol: "", name: "", balance: null, bridgePaused: paused.result };
  }
  if (remoteToken.status !== "success" || decimals.status !== "success" || symbol.status !== "success" || name.status !== "success" || balance.status !== "success") {
    throw new Error("Could not read this bridge wrapper's details. Try again in a moment.");
  }
  return {
    address: token,
    official: true,
    remoteToken: remoteToken.result,
    decimals: decimals.result,
    symbol: symbol.result,
    name: name.result,
    balance: holder ? balance.result : null,
    bridgePaused: paused.result
  };
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
