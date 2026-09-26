import { address } from "@solana/kit";

// Every value below mirrors the official base/bridge Solana program IDL (tests/fixtures/bridge.idl.json,
// vendored at the commit recorded in tests/fixtures/bridge.idl.commit). tests/unit/idl-parity.test.ts
// fails if any of them drift from the vendored IDL.

export const SYSTEM_PROGRAM = address("11111111111111111111111111111111");
export const TOKEN_PROGRAM = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const TOKEN_2022_PROGRAM = address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
export const ASSOCIATED_TOKEN_PROGRAM = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

const utf8 = (value: string) => new TextEncoder().encode(value);

export const SEEDS = {
  bridge: utf8("bridge"),
  outputRoot: utf8("output_root"),
  incomingMessage: utf8("incoming_message"),
  tokenVault: utf8("token_vault"),
  solVault: utf8("sol_vault")
} as const;

export const INSTRUCTION_DISCRIMINATORS = {
  proveMessage: [172, 66, 78, 136, 158, 187, 47, 115],
  relayMessage: [187, 90, 182, 138, 51, 248, 175, 98],
  initializeProveBuffer: [20, 200, 91, 188, 138, 211, 253, 222],
  appendToProveBufferData: [4, 153, 157, 132, 144, 253, 235, 44],
  appendToProveBufferProof: [234, 13, 59, 98, 112, 207, 250, 184],
  proveMessageBuffered: [211, 48, 193, 183, 2, 51, 102, 159],
  closeProveBuffer: [79, 14, 144, 49, 3, 124, 210, 74]
} as const satisfies Record<string, readonly number[]>;

export const ACCOUNT_DISCRIMINATORS = {
  bridge: [231, 232, 31, 98, 110, 3, 23, 59],
  incomingMessage: [30, 144, 125, 111, 211, 223, 91, 170],
  outputRoot: [11, 31, 168, 201, 229, 8, 180, 198],
  proveBuffer: [78, 160, 227, 163, 97, 140, 40, 149]
} as const satisfies Record<string, readonly number[]>;

/** `TokenLib.NATIVE_SOL_PUBKEY` on Base: the remote token of the SOL wrapper ("SoL1111…"). */
export const NATIVE_SOL_REMOTE_TOKEN = "0x069be72ab836d4eacc02525b7350a78a395da2f1253a40ebafd6630000000000" as const;
