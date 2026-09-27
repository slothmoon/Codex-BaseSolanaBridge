import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { address, getBase64Encoder, type Address } from "@solana/kit";
import { hexToBytes, keccak256, type Hex } from "viem";

import { addressToBytes, concatBytes, u32le, u64le } from "../src/protocol/bytes";
import type { BridgeTransfer } from "../src/protocol/message";

const base64 = getBase64Encoder();
export const fromBase64 = (value: string) => new Uint8Array(base64.encode(value));

type RawFixture = {
  program: string;
  bridge: { address: string; data: string };
  outputRoot: { address: string; block: string; data: string };
  messages: {
    txHash: Hex;
    baseBlock: string;
    from: Hex;
    messageHash: Hex;
    nonce: string;
    sender: Hex;
    data: Hex;
    incomingMessage: { address: string; owner: string; data: string };
    proof: Hex[];
  }[];
  mints: { address: string; owner: string; data: string }[];
  vaults: { address: string; mint: string; baseToken: Hex; owner: string; data: string }[];
  solVault: { address: string; lamports: string };
};

export const mainnet = JSON.parse(readFileSync(resolve(__dirname, "fixtures/mainnet.json"), "utf8")) as RawFixture;
export const idl = JSON.parse(readFileSync(resolve(__dirname, "fixtures/bridge.idl.json"), "utf8")) as {
  address: string;
  instructions: { name: string; discriminator: number[]; accounts: { name: string; writable?: boolean; signer?: boolean }[]; args: { name: string; type: unknown }[] }[];
  accounts: { name: string; discriminator: number[] }[];
  errors: { code: number; name: string; msg?: string }[];
  constants: { name: string; type: unknown; value: string }[];
};

export const program = address(mainnet.program);

export function message(kind: "spl" | "sol" | "wrapped", index = 0) {
  const prefix = { sol: "0x0100", spl: "0x0101", wrapped: "0x0102" }[kind];
  const found = mainnet.messages.filter((item) => item.data.startsWith(prefix))[index];
  if (!found) throw new Error(`No ${kind} fixture`);
  return { ...found, nonce: BigInt(found.nonce), baseBlock: BigInt(found.baseBlock), incomingAddress: address(found.incomingMessage.address) as Address };
}

export const payer = address("DZaZMpR6ZBNPKBqaweGnoPP3QLq3pyoRTDfBpYS1QMU2");

/** Encodes a plain transfer message the way Base's SVMBridgeLib.serializeTransfer does (no follow-up instructions). */
export function encodeTransferMessage(transfer: BridgeTransfer): Uint8Array {
  const body =
    transfer.kind === "sol"
      ? concatBytes([0], addressToBytes(transfer.to), u64le(transfer.amount))
      : transfer.kind === "spl"
        ? concatBytes([1], hexToBytes(transfer.baseToken), addressToBytes(transfer.mint), addressToBytes(transfer.to), u64le(transfer.amount))
        : concatBytes([2], addressToBytes(transfer.mint), addressToBytes(transfer.to), u64le(transfer.amount));
  return concatBytes([1], body, u32le(0));
}

/** `keccak256(nonce_be_u64 || sender || data)`: the leaf hash Base emits and the Solana program recomputes. */
export function hashBridgeMessage(nonce: bigint, sender: Hex, data: Uint8Array): Hex {
  const nonceBe = new Uint8Array(8);
  new DataView(nonceBe.buffer).setBigUint64(0, nonce, false);
  return keccak256(concatBytes(nonceBe, hexToBytes(sender), data));
}
