import type { WalletAccount } from "@wallet-standard/base";
import { describe, expect, it, vi } from "vitest";

// Status lookups and claim preparation are faked so their timing can be controlled.
vi.mock("../../src/core/status", async (original) => ({
  ...(await original<typeof import("../../src/core/status")>()),
  trackTransaction: vi.fn(async ({ txHash }: { txHash: string }) => ({ state: "ready", txHash }))
}));
let finishPrepare: (value: unknown) => void = () => undefined;
vi.mock("../../src/core/claim", async (original) => ({
  ...(await original<typeof import("../../src/core/claim")>()),
  prepareClaim: vi.fn(() => new Promise((resolve) => (finishPrepare = resolve)))
}));
vi.mock("../../src/wallets/solana", async (original) => ({
  ...(await original<typeof import("../../src/wallets/solana")>()),
  toSolanaSigner: () => ({ address: "DZaZMpR6ZBNPKBqaweGnoPP3QLq3pyoRTDfBpYS1QMU2", supportsV1: false, signTransaction: async () => new Uint8Array() })
}));

const state = await import("../../src/state/app");
const A = `0x${"a".repeat(64)}`;
const B = `0x${"b".repeat(64)}`;

describe("claim review", () => {
  it("drops a finished claim preparation if another transaction was tracked meanwhile", async () => {
    state.solanaWallet.value = { name: "x", icon: "", wallet: {} as never };
    state.solanaAccount.value = { address: "DZaZMpR6ZBNPKBqaweGnoPP3QLq3pyoRTDfBpYS1QMU2", publicKey: new Uint8Array(32), chains: [], features: [] } as WalletAccount;
    await state.track(A);
    const review = state.reviewClaim(); // preparing the claim for A…
    await state.track(B); // …while the user switches to B
    finishPrepare({ plan: "for A" });
    await review;
    expect(state.tracked.value).toMatchObject({ status: "ready", value: { txHash: B } });
    expect(state.claimPrep.value.status).toBe("idle"); // A's plan never shows up on B's screen
  });
});
