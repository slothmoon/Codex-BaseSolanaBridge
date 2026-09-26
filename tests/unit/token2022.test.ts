import { describe, expect, it } from "vitest";

import { decodeMint, decodeTokenAccount } from "../../src/protocol/accounts";
import { concatBytes, u64le } from "../../src/protocol/bytes";
import { assessDestination, assessMint, associatedAccountSize, Ext, transferFeeFor } from "../../src/protocol/token2022";
import { fromBase64, mainnet } from "../helpers";

function tlv(type: number, value: Uint8Array): Uint8Array {
  const header = new Uint8Array(4);
  new DataView(header.buffer).setUint16(0, type, true);
  new DataView(header.buffer).setUint16(2, value.length, true);
  return concatBytes(header, value);
}

/** A Token-2022 mint (82-byte base, padded to 165, account type 1) with the given extensions. */
function mintWith(...extensions: Uint8Array[]): Uint8Array {
  const base = new Uint8Array(165);
  base[44] = 6; // decimals
  base[45] = 1; // initialized
  return concatBytes(base, [1], ...extensions);
}

function tokenAccountWith(state: number, ...extensions: Uint8Array[]): Uint8Array {
  const base = new Uint8Array(165);
  base[108] = state;
  return concatBytes(base, [2], ...extensions);
}

const u16 = (value: number) => {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value, true);
  return out;
};
const transferFee = (bps: number, max: bigint, epoch = 0n) => concatBytes(u64le(epoch), u64le(max), u16(bps));
const feeConfig = (older: Uint8Array, newer: Uint8Array) => tlv(Ext.TransferFeeConfig, concatBytes(new Uint8Array(72), older, newer));
const codes = (bytes: Uint8Array) => assessMint(decodeMint(bytes), true).map((finding) => `${finding.level}:${finding.code}`);

describe("Token-2022 mint assessment", () => {
  it("does not block a real mainnet Token-2022 mint without dangerous features (PYUSD)", () => {
    const pyusd = decodeMint(fromBase64(mainnet.mints[1].data));
    const findings = assessMint(pyusd, true);
    expect(findings.filter((finding) => finding.level === "block")).toEqual([]);
    expect(findings.map((finding) => finding.code)).toEqual(["permanent-delegate"]);
  });

  it("blocks a mint whose transfer hook the relay cannot satisfy", () => {
    const hook = tlv(Ext.TransferHook, concatBytes(new Uint8Array(32), new Uint8Array(32).fill(7)));
    expect(codes(mintWith(hook))).toContain("block:transfer-hook");
    const emptyHook = tlv(Ext.TransferHook, new Uint8Array(64));
    expect(codes(mintWith(emptyHook))).toEqual([]);
  });

  it("blocks non-transferable, paused and default-frozen mints", () => {
    expect(codes(mintWith(tlv(Ext.NonTransferable, new Uint8Array())))).toContain("block:non-transferable");
    expect(codes(mintWith(tlv(Ext.PausableConfig, concatBytes(new Uint8Array(32), [1]))))).toContain("block:paused");
    expect(codes(mintWith(tlv(Ext.PausableConfig, concatBytes(new Uint8Array(32), [0]))))).toContain("warn:pausable");
    expect(codes(mintWith(tlv(Ext.DefaultAccountState, new Uint8Array([2]))))).toContain("block:default-frozen");
    expect(codes(mintWith(tlv(Ext.DefaultAccountState, new Uint8Array([1]))))).toEqual([]);
  });

  it("warns about fees, delegates and UI scaling", () => {
    expect(codes(mintWith(feeConfig(transferFee(50, 1_000n), transferFee(50, 1_000n))))).toContain("warn:transfer-fee");
    expect(codes(mintWith(tlv(Ext.PermanentDelegate, new Uint8Array(32).fill(3))))).toContain("warn:permanent-delegate");
    expect(codes(mintWith(tlv(Ext.ScaledUiAmountConfig, new Uint8Array(56))))).toContain("warn:ui-scaling");
  });

  it("computes the withheld fee like the token program (ceil, capped, epoch-aware)", () => {
    const ext = decodeMint(mintWith(feeConfig(transferFee(100, 5_000n, 0n), transferFee(250, 1_000_000n, 900n)))).extensions;
    expect(transferFeeFor(10_000n, ext, 10n)).toBe(100n); // older schedule: 1%
    expect(transferFeeFor(1_000_001n, ext, 10n)).toBe(5_000n); // capped
    expect(transferFeeFor(10_000n, ext, 900n)).toBe(250n); // newer schedule: 2.5%
    expect(transferFeeFor(3n, ext, 900n)).toBe(1n); // rounds up
    expect(transferFeeFor(10_000n, ext, null)).toBe(250n); // unknown epoch: assume the higher schedule
  });

  it("sizes the associated token account the claim would create", () => {
    expect(associatedAccountSize(new Map(), false)).toBe(165);
    expect(associatedAccountSize(new Map(), true)).toBe(170);
    const ext = decodeMint(mintWith(feeConfig(transferFee(0, 0n), transferFee(0, 0n)), tlv(Ext.TransferHook, new Uint8Array(64)))).extensions;
    expect(associatedAccountSize(ext, true)).toBe(170 + 12 + 5);
  });
});

describe("destination checks", () => {
  it("blocks frozen accounts and accounts that require memos", () => {
    expect(assessDestination(decodeTokenAccount(tokenAccountWith(2))).map((finding) => finding.code)).toEqual(["destination-frozen"]);
    expect(assessDestination(decodeTokenAccount(tokenAccountWith(1, tlv(Ext.MemoTransfer, new Uint8Array([1]))))).map((finding) => finding.code)).toEqual(["memo-required"]);
    expect(assessDestination(decodeTokenAccount(tokenAccountWith(1, tlv(Ext.ImmutableOwner, new Uint8Array()))))).toEqual([]);
  });

  it("rejects an account whose Token-2022 type byte is wrong", () => {
    expect(() => decodeTokenAccount(concatBytes(new Uint8Array(165), [1]))).toThrow(/account type/);
  });
});
