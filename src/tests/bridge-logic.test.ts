import { describe, expect, it } from "vitest";
import { TransactionReceiptNotFoundError } from "viem";

import {
  assertBridgeActive,
  assertSingleBridgeEventCount,
  isBurnValidationCurrent,
  isTransactionReceiptPending,
  nextRootBlock,
  rootBlocksRemaining
} from "../bridge-logic";

describe("Base receipt classification", () => {
  it("treats only receipt-not-found errors as pending", () => {
    const pending = new TransactionReceiptNotFoundError({ hash: `0x${"11".repeat(32)}` });
    expect(isTransactionReceiptPending(pending)).toBe(true);
    expect(isTransactionReceiptPending(new Error("RPC timeout"))).toBe(false);
  });

  it("recognizes a wrapped receipt-not-found cause", () => {
    const pending = new TransactionReceiptNotFoundError({ hash: `0x${"22".repeat(32)}` });
    expect(isTransactionReceiptPending({ name: "FallbackTransportError", cause: pending })).toBe(true);
  });
});

describe("Solana bridge safety", () => {
  it("allows an active bridge and blocks a paused bridge", () => {
    expect(() => assertBridgeActive(false)).not.toThrow();
    expect(() => assertBridgeActive(true)).toThrow(/currently paused/i);
  });
});

describe("burn validation", () => {
  it("accepts an unchanged validated route", () => {
    expect(isBurnValidationCurrent("a|b|c", "a|b|c", "a|b|c")).toBe(true);
  });

  it("rejects cleared or changed route state", () => {
    expect(isBurnValidationCurrent("a|b|c", "", "a|b|c")).toBe(false);
    expect(isBurnValidationCurrent("a|b|c", "a|b|c", "a|b|d")).toBe(false);
  });
});

describe("output-root progress", () => {
  it("rounds a burn block up to the next interval", () => {
    expect(nextRootBlock(601n, 300n)).toBe(900n);
    expect(nextRootBlock(600n, 300n)).toBe(600n);
  });

  it("reports distance from the latest root to the eligible root", () => {
    expect(rootBlocksRemaining(601n, 600n, 300n)).toBe(300n);
    expect(rootBlocksRemaining(601n, 900n, 300n)).toBe(0n);
  });
});

describe("bridge event selection", () => {
  it("accepts zero or one event and rejects ambiguous receipts", () => {
    expect(() => assertSingleBridgeEventCount(0)).not.toThrow();
    expect(() => assertSingleBridgeEventCount(1)).not.toThrow();
    expect(() => assertSingleBridgeEventCount(2)).toThrow(/multiple bridge messages/i);
  });
});
