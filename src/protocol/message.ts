import type { Address } from "@solana/kit";
import { bytesToHex, type Hex } from "viem";

import { ByteReader } from "./bytes";

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
