import type { WalletAccount } from "@wallet-standard/base";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Status lookups, claim preparation and claim execution are faked so their timing can be controlled.
let holdLookup: Promise<void> | null = null; // when set, status lookups wait for it
vi.mock("../../src/core/status", async (original) => ({
  ...(await original<typeof import("../../src/core/status")>()),
  trackTransaction: vi.fn(async ({ txHash }: { txHash: string }) => {
    if (holdLookup) await holdLookup;
    return { state: "ready", txHash };
  })
}));
let finishPrepare: (value: unknown) => void = () => undefined;
let finishClaim: (value: unknown) => void = () => undefined;
vi.mock("../../src/core/claim", async (original) => ({
  ...(await original<typeof import("../../src/core/claim")>()),
  prepareClaim: vi.fn(({ status }: { status: unknown }) => new Promise((resolve) => (finishPrepare = () => resolve({ status, plan: { txs: [] } })))),
  executeClaim: vi.fn(() => new Promise((resolve) => (finishClaim = resolve)))
}));
vi.mock("../../src/wallets/solana", async (original) => ({
  ...(await original<typeof import("../../src/wallets/solana")>()),
  toSolanaSigner: () => ({ address: "DZaZMpR6ZBNPKBqaweGnoPP3QLq3pyoRTDfBpYS1QMU2", supportsV1: false, signTransaction: async () => new Uint8Array() })
}));

const state = await import("../../src/state/app");
const A = `0x${"a".repeat(64)}`;
const B = `0x${"b".repeat(64)}`;
const shown = () => (state.tracked.value.status === "ready" ? state.tracked.value.value.txHash : null);

beforeEach(() => {
  state.solanaWallet.value = { name: "x", icon: "", wallet: {} as never };
  state.solanaAccount.value = { address: "DZaZMpR6ZBNPKBqaweGnoPP3QLq3pyoRTDfBpYS1QMU2", publicKey: new Uint8Array(32), chains: [], features: [] } as WalletAccount;
});

describe("claim review and claim while the user moves around", () => {
  it("drops a finished claim preparation if another transaction was tracked meanwhile", async () => {
    await state.track(A);
    const review = state.reviewClaim(); // preparing the claim for A…
    await state.track(B); // …while the user switches to B
    finishPrepare(undefined);
    await review;
    expect(shown()).toBe(B);
    expect(state.claimPrep.value.status).toBe("idle"); // A's plan never shows up on B's screen
  });

  it("keeps a finished preparation when the user re-tracks the same transaction", async () => {
    await state.track(A);
    const review = state.reviewClaim();
    let release = () => undefined as void;
    holdLookup = new Promise((resolve) => (release = resolve));
    const refresh = state.track(A); // same transaction, clicked Track again; still loading…
    finishPrepare(undefined); // …when the preparation finishes
    await review;
    holdLookup = null;
    release();
    await refresh;
    expect(state.claimPrep.value.status).toBe("ready"); // not stuck on the spinner
  });

  it("lets a claim finish quietly if another transaction was tracked meanwhile", async () => {
    await state.track(A);
    const review = state.reviewClaim();
    finishPrepare(undefined);
    await review;
    const claim = state.runClaim(); // claiming A…
    await state.track(B); // …while the user switches to B
    finishClaim({ signatures: ["sigA"] });
    await claim;
    expect(shown()).toBe(B); // not yanked back to A
    expect(state.claimRun.value.status).toBe("idle"); // and A's result isn't shown on B
  });

  it("keeps the claim result when the user clicks Track on it just as the claim finishes", async () => {
    await state.track(A);
    const review = state.reviewClaim();
    finishPrepare(undefined);
    await review;
    const claim = state.runClaim();
    let release = () => undefined as void;
    holdLookup = new Promise((resolve) => (release = resolve));
    const refresh = state.track(A); // Track clicked on the same transfer; still loading…
    finishClaim({ signatures: ["sigA"] }); // …when the claim finishes
    await Promise.resolve();
    holdLookup = null;
    release();
    await Promise.all([claim, refresh]);
    expect(shown()).toBe(A);
    expect(state.claimRun.value).toEqual({ status: "ready", value: { signatures: ["sigA"] } });
  });

  it("shows the result of a claim on the transaction it belongs to", async () => {
    await state.track(A);
    const review = state.reviewClaim();
    finishPrepare(undefined);
    await review;
    const claim = state.runClaim();
    finishClaim({ signatures: ["sigA"] });
    await claim;
    expect(shown()).toBe(A);
    expect(state.claimRun.value).toEqual({ status: "ready", value: { signatures: ["sigA"] } });
  });
});
