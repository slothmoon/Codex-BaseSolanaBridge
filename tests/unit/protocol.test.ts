import { address } from "@solana/kit";
import { hexToBytes } from "viem";
import { describe, expect, it } from "vitest";

import {
  decodeBridgeAccount,
  decodeIncomingMessage,
  decodeMint,
  decodeOutputRoot,
  decodeTokenAccount,
  incomingMessageSpace
} from "../../src/protocol/accounts";
import { concatBytes, u32le } from "../../src/protocol/bytes";
import { findIncomingMessagePda, findOutputRootPda, findTokenVaultPda } from "../../src/protocol/instructions";
import { decodeBridgeMessage } from "../../src/protocol/message";
import { mmrRootFromProof, verifyMmrProof } from "../../src/protocol/mmr";
import { encodeTransferMessage, fromBase64, hashBridgeMessage, mainnet, message, program } from "../helpers";

const root = decodeOutputRoot(fromBase64(mainnet.outputRoot.data));

describe("bridge messages (real mainnet payloads)", () => {
  it("decodes SPL, SOL and wrapped-token transfers", () => {
    const spl = decodeBridgeMessage(hexToBytes(message("spl").data));
    expect(spl).toMatchObject({ type: "transfer", instructionCount: 0, transfer: { kind: "spl" } });
    const sol = decodeBridgeMessage(hexToBytes(message("sol").data));
    expect(sol).toMatchObject({ type: "transfer", instructionCount: 0, transfer: { kind: "sol" } });
    const wrapped = decodeBridgeMessage(hexToBytes(message("wrapped").data));
    expect(wrapped).toMatchObject({ type: "transfer", instructionCount: 0, transfer: { kind: "wrapped" } });
  });

  it("re-encodes each payload byte-for-byte", () => {
    for (const kind of ["spl", "sol", "wrapped"] as const) {
      const data = hexToBytes(message(kind).data);
      const decoded = decodeBridgeMessage(data);
      if (decoded.type !== "transfer") throw new Error("expected transfer");
      expect(encodeTransferMessage(decoded.transfer)).toEqual(data);
    }
  });

  it("reproduces the leaf hash Base emitted and Solana recomputes", () => {
    for (const fixture of mainnet.messages) {
      expect(hashBridgeMessage(BigInt(fixture.nonce), fixture.sender, hexToBytes(fixture.data))).toBe(fixture.messageHash);
    }
  });

  it("reports follow-up instructions instead of hiding them", () => {
    const data = hexToBytes(message("spl").data);
    const withIx = concatBytes(data.subarray(0, data.length - 4), u32le(2), new Uint8Array(40));
    expect(decodeBridgeMessage(withIx)).toMatchObject({ type: "transfer", instructionCount: 2 });
    expect(decodeBridgeMessage(concatBytes([0], u32le(1), new Uint8Array(10)))).toEqual({ type: "call", instructionCount: 1 });
  });

  it("rejects trailing bytes, truncation and unknown variants", () => {
    const data = hexToBytes(message("spl").data);
    expect(() => decodeBridgeMessage(concatBytes(data, [0]))).toThrow(/trailing/);
    expect(() => decodeBridgeMessage(data.subarray(0, 50))).toThrow(/shorter/);
    expect(() => decodeBridgeMessage(new Uint8Array([2]))).toThrow(/variant/);
    expect(() => decodeBridgeMessage(new Uint8Array([1, 3]))).toThrow(/variant/);
  });
});

describe("MMR proofs (real mainnet proofs against the on-chain root)", () => {
  it("verifies every captured proof against the Solana output root", () => {
    for (const fixture of mainnet.messages) {
      expect(verifyMmrProof({ root: root.root, leafHash: fixture.messageHash, leafIndex: BigInt(fixture.nonce), proof: fixture.proof, totalLeafCount: root.totalLeafCount })).toBe(true);
    }
  });

  it("rejects tampered proofs, wrong leaves and uncovered indexes", () => {
    const fixture = mainnet.messages[0];
    const base = { root: root.root, leafHash: fixture.messageHash, leafIndex: BigInt(fixture.nonce), proof: fixture.proof, totalLeafCount: root.totalLeafCount };
    const tampered = [...fixture.proof];
    tampered[0] = `0x${"00".repeat(32)}`;
    expect(verifyMmrProof({ ...base, proof: tampered })).toBe(false);
    expect(verifyMmrProof({ ...base, proof: fixture.proof.slice(1) })).toBe(false);
    expect(verifyMmrProof({ ...base, leafHash: mainnet.messages[1].messageHash })).toBe(false);
    expect(verifyMmrProof({ ...base, leafIndex: root.totalLeafCount })).toBe(false);
    expect(() => mmrRootFromProof([...fixture.proof, fixture.proof[0]], fixture.messageHash, BigInt(fixture.nonce), root.totalLeafCount)).toThrow(/unused/);
  });
});

describe("account decoding (real mainnet accounts)", () => {
  it("reads the bridge account", () => {
    const bridge = decodeBridgeAccount(fromBase64(mainnet.bridge.data));
    expect(bridge.baseBlockNumber).toBe(BigInt(mainnet.outputRoot.block));
    expect(bridge.blockIntervalRequirement).toBe(300n);
    expect(bridge.paused).toBe(false);
  });

  it("reads output roots and executed proof accounts", () => {
    expect(root.totalLeafCount).toBeGreaterThan(0n);
    for (const fixture of mainnet.messages) {
      const length = hexToBytes(fixture.data).length;
      const data = fromBase64(fixture.incomingMessage.data);
      expect(data.length).toBe(incomingMessageSpace(length));
      expect(decodeIncomingMessage(data, length)).toEqual({ sender: fixture.sender.toLowerCase(), executed: true });
    }
  });

  it("rejects a wrong discriminator, size or flag", () => {
    const fixture = mainnet.messages[0];
    const length = hexToBytes(fixture.data).length;
    const data = fromBase64(fixture.incomingMessage.data);
    expect(() => decodeIncomingMessage(data, length + 1)).toThrow(/size/);
    const wrong = data.slice();
    wrong[0] ^= 1;
    expect(() => decodeIncomingMessage(wrong, length)).toThrow(/discriminator/);
    const badFlag = data.slice();
    badFlag[8 + 20 + length] = 7;
    expect(() => decodeIncomingMessage(badFlag, length)).toThrow(/boolean/);
    const bridge = fromBase64(mainnet.bridge.data).slice();
    bridge[56] = 2;
    expect(() => decodeBridgeAccount(bridge)).toThrow(/boolean/);
  });

  it("derives the same PDAs the chain uses", async () => {
    expect(await findOutputRootPda(program, BigInt(mainnet.outputRoot.block))).toBe(mainnet.outputRoot.address);
    for (const fixture of mainnet.messages) {
      expect(await findIncomingMessagePda(program, fixture.messageHash)).toBe(fixture.incomingMessage.address);
    }
    const vault = mainnet.vaults[0];
    expect(await findTokenVaultPda(program, address(vault.mint), vault.baseToken)).toBe(vault.address);
  });

  it("reads Standard and Token-2022 mints and vault token accounts", () => {
    const jito = decodeMint(fromBase64(mainnet.mints[0].data));
    expect(jito).toMatchObject({ decimals: 9, isInitialized: true });
    const pyusd = decodeMint(fromBase64(mainnet.mints[1].data));
    expect(pyusd.decimals).toBe(6);
    const vault = decodeTokenAccount(fromBase64(mainnet.vaults[0].data));
    expect(vault.mint).toBe(mainnet.vaults[0].mint);
    expect(vault.owner).toBe(mainnet.vaults[0].address);
    expect(vault.state).toBe("initialized");
  });
});
