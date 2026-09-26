import type { Address } from "@solana/kit";
import { bytesToHex, keccak256, type Hex } from "viem";

import { addressToBytes, ByteReader, concatBytes, u32le, u64le } from "./bytes";

/**
 * The Borsh-serialized `Message` that Base's `SVMBridgeLib.serializeTransfer` emits and the Solana
 * program's `prove_message` deserializes (solana/programs/bridge/src/base_to_solana/state/incoming_message.rs):
 *
 *   enum Message { Call(Vec<Ix>) = 0, Transfer { transfer: Transfer, ixs: Vec<Ix> } = 1 }
 *   enum Transfer { Sol(FinalizeBridgeSol) = 0, Spl(FinalizeBridgeSpl) = 1, WrappedToken(FinalizeBridgeWrappedToken) = 2 }
 */
export type BridgeTransfer =
  /** Native SOL leaving the SOL vault. `to` is a wallet (system account). */
  | { kind: "sol"; to: Address; amount: bigint }
  /** An SPL mint leaving its token vault. `baseToken` is the 20-byte Base wrapper; `to` is a token account. */
  | { kind: "spl"; baseToken: Hex; mint: Address; to: Address; amount: bigint }
  /** A Base-native token minted as a Solana wrapped token. `to` is a Token-2022 token account. */
  | { kind: "wrapped"; mint: Address; to: Address; amount: bigint };

export type BridgeMessage =
  | { type: "transfer"; transfer: BridgeTransfer; instructionCount: number }
  | { type: "call"; instructionCount: number };

export function decodeBridgeMessage(data: Uint8Array): BridgeMessage {
  const reader = new ByteReader(data, "bridge message");
  const variant = reader.u8();

  if (variant === 0) {
    return { type: "call", instructionCount: reader.u32() };
  }
  if (variant !== 1) throw new Error(`Unknown bridge message variant ${variant}.`);

  const transferKind = reader.u8();
  let transfer: BridgeTransfer;
  if (transferKind === 0) {
    transfer = { kind: "sol", to: reader.address(), amount: reader.u64() };
  } else if (transferKind === 1) {
    const baseToken = bytesToHex(reader.bytes_(20));
    transfer = { kind: "spl", baseToken, mint: reader.address(), to: reader.address(), amount: reader.u64() };
  } else if (transferKind === 2) {
    transfer = { kind: "wrapped", mint: reader.address(), to: reader.address(), amount: reader.u64() };
  } else {
    throw new Error(`Unknown bridge transfer variant ${transferKind}.`);
  }

  const instructionCount = reader.u32();
  if (instructionCount === 0 && reader.remaining !== 0) {
    throw new Error("The bridge message has unexpected trailing bytes.");
  }
  return { type: "transfer", transfer, instructionCount };
}

/** Encodes a plain transfer message (no follow-up instructions). Used for tests and size planning. */
export function encodeTransferMessage(transfer: BridgeTransfer): Uint8Array {
  const body =
    transfer.kind === "sol"
      ? concatBytes([0], addressToBytes(transfer.to), u64le(transfer.amount))
      : transfer.kind === "spl"
        ? concatBytes([1], hexBytes(transfer.baseToken, 20), addressToBytes(transfer.mint), addressToBytes(transfer.to), u64le(transfer.amount))
        : concatBytes([2], addressToBytes(transfer.mint), addressToBytes(transfer.to), u64le(transfer.amount));
  return concatBytes([1], body, u32le(0));
}

/**
 * `keccak256(nonce_be_u64 || sender || data)`: the leaf hash Base emits in `MessageInitiated` and the
 * hash the Solana program recomputes in `prove_message`.
 */
export function hashBridgeMessage(nonce: bigint, sender: Hex, data: Uint8Array): Hex {
  const nonceBe = new Uint8Array(8);
  new DataView(nonceBe.buffer).setBigUint64(0, nonce, false);
  return keccak256(concatBytes(nonceBe, hexBytes(sender, 20), data));
}

function hexBytes(value: Hex, length: number): Uint8Array {
  const clean = value.slice(2);
  if (clean.length !== length * 2) throw new Error(`Expected ${length} bytes, got ${clean.length / 2}.`);
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}
