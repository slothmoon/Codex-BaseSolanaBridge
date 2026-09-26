import { AccountRole, address, type Instruction } from "@solana/kit";
import { describe, expect, it } from "vitest";

import { ACCOUNT_DISCRIMINATORS, INSTRUCTION_DISCRIMINATORS, NATIVE_SOL_REMOTE_TOKEN, SEEDS } from "../../src/protocol/constants";
import {
  appendToProveBufferDataInstruction,
  appendToProveBufferProofInstruction,
  closeProveBufferInstruction,
  initializeProveBufferInstruction,
  proveMessageBufferedInstruction,
  proveMessageInstruction,
  relayMessageInstruction
} from "../../src/protocol/instructions";
import { BRIDGE_PROGRAM_ERRORS } from "../../src/protocol/program-errors";
import { bytesToAddress, hexToBytes } from "../../src/protocol/bytes";
import { idl, program } from "../helpers";

const snake = (value: string) => value.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
const idlInstruction = (name: string) => {
  const found = idl.instructions.find((ix) => ix.name === name);
  if (!found) throw new Error(`IDL has no ${name}`);
  return found;
};

const a = (n: number) => address(bytesToAddress(new Uint8Array(32).fill(n)));

/** Every instruction builder, invoked with distinct dummy accounts. */
const built: Record<keyof typeof INSTRUCTION_DISCRIMINATORS, Instruction> = {
  proveMessage: proveMessageInstruction({ program, payer: a(1), outputRoot: a(2), message: a(3), bridge: a(4), nonce: 7n, sender: `0x${"11".repeat(20)}`, data: new Uint8Array([1, 2, 3]), proof: [`0x${"22".repeat(32)}`], messageHash: `0x${"33".repeat(32)}` }),
  relayMessage: relayMessageInstruction({ program, message: a(3), bridge: a(4), remainingAccounts: [] }),
  initializeProveBuffer: initializeProveBufferInstruction({ program, payer: a(1), bridge: a(4), buffer: a(5), maxDataLength: 98, maxProofLength: 20 }),
  appendToProveBufferData: appendToProveBufferDataInstruction({ program, owner: a(1), buffer: a(5), chunk: new Uint8Array([9, 9]) }),
  appendToProveBufferProof: appendToProveBufferProofInstruction({ program, owner: a(1), buffer: a(5), proof: [`0x${"44".repeat(32)}`] }),
  proveMessageBuffered: proveMessageBufferedInstruction({ program, payer: a(1), outputRoot: a(2), message: a(3), bridge: a(4), buffer: a(5), nonce: 7n, sender: `0x${"11".repeat(20)}`, messageHash: `0x${"33".repeat(32)}` }),
  closeProveBuffer: closeProveBufferInstruction({ program, owner: a(1), buffer: a(5) })
};

describe("parity with the vendored official IDL", () => {
  it("uses the IDL discriminator for every instruction", () => {
    for (const [name, discriminator] of Object.entries(INSTRUCTION_DISCRIMINATORS)) {
      expect(idlInstruction(snake(name)).discriminator, name).toEqual([...discriminator]);
      expect([...built[name as keyof typeof built].data!.subarray(0, 8)], name).toEqual([...discriminator]);
    }
  });

  it("uses the IDL discriminator for every decoded account", () => {
    const names: Record<keyof typeof ACCOUNT_DISCRIMINATORS, string> = { bridge: "Bridge", incomingMessage: "IncomingMessage", outputRoot: "OutputRoot", proveBuffer: "ProveBuffer" };
    for (const [key, name] of Object.entries(names)) {
      expect(idl.accounts.find((account) => account.name === name)?.discriminator, name).toEqual([...ACCOUNT_DISCRIMINATORS[key as keyof typeof names]]);
    }
  });

  it("matches the IDL's writable and signer flags for every fixed account", () => {
    for (const [name, ix] of Object.entries(built)) {
      const spec = idlInstruction(snake(name));
      const fixed = ix.accounts!.slice(0, spec.accounts.length);
      expect(fixed.length, name).toBe(spec.accounts.length);
      spec.accounts.forEach((account, index) => {
        const role = fixed[index].role;
        const writable = role === AccountRole.WRITABLE || role === AccountRole.WRITABLE_SIGNER;
        const signer = role === AccountRole.READONLY_SIGNER || role === AccountRole.WRITABLE_SIGNER;
        expect({ name: account.name, writable, signer }, `${name}.${account.name}`).toEqual({ name: account.name, writable: Boolean(account.writable), signer: Boolean(account.signer) });
      });
    }
  });

  it("serializes arguments in the IDL's Borsh layout", () => {
    // prove_message(nonce u64, sender [u8;20], data bytes, proof Vec<[u8;32]>, message_hash [u8;32])
    expect(built.proveMessage.data!.length).toBe(8 + 8 + 20 + (4 + 3) + (4 + 32) + 32);
    // initialize_prove_buffer(max_data_len u64, max_proof_len u64)
    const init = built.initializeProveBuffer.data!;
    expect(new DataView(init.buffer, init.byteOffset).getBigUint64(8, true)).toBe(98n);
    expect(new DataView(init.buffer, init.byteOffset).getBigUint64(16, true)).toBe(20n);
    // prove_message_buffered(nonce u64, sender [u8;20], message_hash [u8;32])
    expect(built.proveMessageBuffered.data!.length).toBe(8 + 8 + 20 + 32);
    expect(built.appendToProveBufferData.data!.length).toBe(8 + 4 + 2);
    expect(built.appendToProveBufferProof.data!.length).toBe(8 + 4 + 32);
    expect(idlInstruction("prove_message").args.map((arg) => arg.name)).toEqual(["nonce", "sender", "data", "proof", "message_hash"]);
    expect(idlInstruction("prove_message_buffered").args.map((arg) => arg.name)).toEqual(["nonce", "sender", "message_hash"]);
  });

  it("uses the IDL's seeds and native SOL constant", () => {
    const constant = (name: string) => idl.constants.find((item) => item.name === name)!.value;
    const bytes = (name: string) => JSON.parse(constant(name)) as number[];
    expect([...SEEDS.bridge]).toEqual(bytes("BRIDGE_SEED"));
    expect([...SEEDS.outputRoot]).toEqual(bytes("OUTPUT_ROOT_SEED"));
    expect([...SEEDS.incomingMessage]).toEqual(bytes("INCOMING_MESSAGE_SEED"));
    expect([...SEEDS.tokenVault]).toEqual(bytes("TOKEN_VAULT_SEED"));
    expect([...SEEDS.solVault]).toEqual(bytes("SOL_VAULT_SEED"));
    expect(bytesToAddress(hexToBytes(NATIVE_SOL_REMOTE_TOKEN))).toBe(constant("NATIVE_SOL_PUBKEY"));
  });

  it("has an error table identical to the IDL", () => {
    expect(Object.keys(BRIDGE_PROGRAM_ERRORS).length).toBe(idl.errors.length);
    for (const error of idl.errors) expect(BRIDGE_PROGRAM_ERRORS[error.code]).toEqual([error.name, error.msg ?? error.name]);
  });
});
