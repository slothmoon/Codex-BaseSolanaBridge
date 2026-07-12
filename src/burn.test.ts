import { describe, expect, it } from "vitest";

import { CONFIG } from "./config";
import { assertMatchingDecimals, assertOfficialWrapper, validateBridgeAmount } from "./burn";

const wrapper = "0x1111111111111111111111111111111111111111" as const;

describe("official wrapper validation", () => {
  it("accepts a factory-approved wrapper bound to the configured bridge", () => {
    expect(() => assertOfficialWrapper(true, wrapper, CONFIG.baseBridge)).not.toThrow();
  });

  it("rejects wrappers not approved by the official factory", () => {
    expect(() => assertOfficialWrapper(false, wrapper, CONFIG.baseBridge)).toThrow(/factory .* returned false/i);
  });

  it("rejects wrappers bound to another bridge", () => {
    expect(() => assertOfficialWrapper(
      true,
      wrapper,
      "0x2222222222222222222222222222222222222222"
    )).toThrow(/not the official bridge/i);
  });
});

describe("cross-chain decimal validation", () => {
  it("accepts matching decimals and rejects a mismatch", () => {
    expect(() => assertMatchingDecimals(6, 6)).not.toThrow();
    expect(() => assertMatchingDecimals(18, 9)).toThrow(/decimal mismatch/i);
  });
});

describe("bridge amount validation", () => {
  const valid = {
    amountInput: "1.25",
    decimals: 6,
    symbol: "TEST",
    wrapperBalance: 2_000_000n,
    vaultBalance: 3_000_000n
  };

  it("parses an amount that both balances cover", () => {
    expect(validateBridgeAmount(valid)).toBe(1_250_000n);
  });

  it("rejects missing, zero, over-precision, and uint64-overflow amounts", () => {
    expect(() => validateBridgeAmount({ ...valid, amountInput: "" })).toThrow(/enter the amount/i);
    expect(() => validateBridgeAmount({ ...valid, amountInput: "0" })).toThrow(/greater than zero/i);
    expect(() => validateBridgeAmount({ ...valid, amountInput: "1.0000001" })).toThrow(/up to 6 decimal places/i);
    expect(() => validateBridgeAmount({
      ...valid,
      amountInput: "18446744073709551616",
      decimals: 0,
      wrapperBalance: 2n ** 65n,
      vaultBalance: 2n ** 65n
    })).toThrow(/uint64/i);
  });

  it("rejects insufficient wrapper and vault balances", () => {
    expect(() => validateBridgeAmount({ ...valid, wrapperBalance: 1_000_000n })).toThrow(/insufficient Base balance/i);
    expect(() => validateBridgeAmount({ ...valid, vaultBalance: 1_000_000n })).toThrow(/bridge vault has only/i);
  });
});
