import type { Address } from "@solana/kit";
import { bytesToHex, type Hex } from "viem";

import { ByteReader, hasPrefix } from "./bytes";
import { ACCOUNT_DISCRIMINATORS } from "./constants";

// ---------------------------------------------------------------------------------------------
// Bridge program accounts (layouts from solana/programs/bridge/src/**/state/*.rs)
// ---------------------------------------------------------------------------------------------

export type BridgeAccount = {
  /** Base block number of the latest registered output root. */
  baseBlockNumber: bigint;
  paused: boolean;
  /** Output roots are only registered at Base blocks that are multiples of this. */
  blockIntervalRequirement: bigint;
};

function expectDiscriminator(data: Uint8Array, discriminator: readonly number[], label: string): void {
  if (!hasPrefix(data, discriminator)) throw new Error(`The ${label} account has an unexpected discriminator.`);
}

export function decodeBridgeAccount(data: Uint8Array): BridgeAccount {
  expectDiscriminator(data, ACCOUNT_DISCRIMINATORS.bridge, "bridge");
  const reader = new ByteReader(data, "bridge account");
  reader.skip(8);
  const baseBlockNumber = reader.u64();
  reader.skip(8 + 32); // nonce, guardian
  const paused = reader.bool();
  reader.skip(56 + 56); // eip1559 (config 4×u64 + 3×u64 state), gas_config (u64, u64, Pubkey, u64)
  const blockIntervalRequirement = reader.u64();
  return { baseBlockNumber, paused, blockIntervalRequirement };
}

export type OutputRootAccount = { root: Hex; totalLeafCount: bigint };

export function decodeOutputRoot(data: Uint8Array): OutputRootAccount {
  expectDiscriminator(data, ACCOUNT_DISCRIMINATORS.outputRoot, "output root");
  const reader = new ByteReader(data, "output root account");
  reader.skip(8);
  return { root: bytesToHex(reader.bytes_(32)), totalLeafCount: reader.u64() };
}

/** Space `prove_message` allocates: discriminator + sender + (4 + data) + executed. */
export function incomingMessageSpace(messageLength: number): number {
  return 8 + 20 + 4 + messageLength + 1;
}

export type IncomingMessageAccount = { sender: Hex; executed: boolean };

/**
 * The `message` field is a Borsh enum (not a Vec), so `executed` sits directly after the raw
 * message bytes; the allocation keeps 4 spare bytes at the end.
 */
export function decodeIncomingMessage(data: Uint8Array, messageLength: number): IncomingMessageAccount {
  expectDiscriminator(data, ACCOUNT_DISCRIMINATORS.incomingMessage, "incoming message");
  if (data.length !== incomingMessageSpace(messageLength)) {
    throw new Error("The incoming message account has an unexpected size for this message.");
  }
  const reader = new ByteReader(data, "incoming message account");
  reader.skip(8);
  const sender = bytesToHex(reader.bytes_(20));
  reader.skip(messageLength);
  return { sender, executed: reader.bool() };
}

// ---------------------------------------------------------------------------------------------
// SPL Token / Token-2022 accounts
// ---------------------------------------------------------------------------------------------

const MINT_BASE_SIZE = 82;
const TOKEN_ACCOUNT_BASE_SIZE = 165;
export type MintAccount = {
  mintAuthority: Address | null;
  supply: bigint;
  decimals: number;
  isInitialized: boolean;
  freezeAuthority: Address | null;
};

function readCOptionAddress(reader: ByteReader): Address | null {
  const tag = reader.u32();
  const value = reader.address();
  if (tag > 1) throw new Error("Invalid optional address tag.");
  return tag === 1 ? value : null;
}

export function decodeMint(data: Uint8Array): MintAccount {
  if (data.length < MINT_BASE_SIZE) throw new Error("The account is not a valid SPL mint.");
  const reader = new ByteReader(data, "mint account");
  const mintAuthority = readCOptionAddress(reader);
  const supply = reader.u64();
  const decimals = reader.u8();
  const isInitialized = reader.bool();
  const freezeAuthority = readCOptionAddress(reader);
  return { mintAuthority, supply, decimals, isInitialized, freezeAuthority };
}

export type TokenAccountState = "uninitialized" | "initialized" | "frozen";

export type TokenAccount = {
  mint: Address;
  owner: Address;
  amount: bigint;
  state: TokenAccountState;
};

export function decodeTokenAccount(data: Uint8Array): TokenAccount {
  if (data.length < TOKEN_ACCOUNT_BASE_SIZE) throw new Error("The account is not a valid token account.");
  const reader = new ByteReader(data, "token account");
  const mint = reader.address();
  const owner = reader.address();
  const amount = reader.u64();
  reader.skip(36); // delegate COption<Pubkey>
  const stateByte = reader.u8();
  if (stateByte > 2) throw new Error("The token account has an invalid state.");
  const state: TokenAccountState = stateByte === 0 ? "uninitialized" : stateByte === 1 ? "initialized" : "frozen";
  return { mint, owner, amount, state };
}

