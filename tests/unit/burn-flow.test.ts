import type { WalletAccount } from "@wallet-standard/base";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The burn flow is exercised with the network-facing pieces mocked, so every wallet outcome can be forced.
const sendBurn = vi.fn();
let findings: { level: "block" | "warn"; code: string; message: string }[] = [];

vi.mock("../../src/wallets/evm", async (original) => ({
  ...(await original<typeof import("../../src/wallets/evm")>()),
  sendBurn: (...args: unknown[]) => sendBurn(...args)
}));
vi.mock("../../src/core/route", async (original) => {
  const actual = await original<typeof import("../../src/core/route")>();
  return {
    ...actual,
    inspectToken: vi.fn(async () => ({ wrapper: { address: TOKEN, symbol: "SOL", decimals: 9 }, findings: [] })),
    buildRoute: vi.fn(async (input: { amountInput: string; evmAccount: string; recipientWallet: string }) => ({
      key: actual.routeKey({ token: TOKEN, amount: input.amountInput, evm: input.evmAccount, solana: input.recipientWallet }),
      inspection: { wrapper: { address: TOKEN, symbol: "SOL", decimals: 9 } },
      evmAccount: input.evmAccount,
      amount: 1n,
      findings,
      transfer: {}
    }))
  };
});
vi.mock("../../src/chain/solana", async (original) => ({
  ...(await original<typeof import("../../src/chain/solana")>()),
  getSolanaRpc: () => ({})
}));

const TOKEN = "0x311935Cd80B76769bF2ecC9D8Ab7635b2139cf82";
const state = await import("../../src/state/app");

async function reviewed() {
  state.tokenInput.value = TOKEN;
  state.amountInput.value = "1";
  state.evmAccount.value = "0x0000000000000000000000000000000000000001";
  state.evmChainId.value = 8453;
  state.evmWallet.value = { info: { uuid: "x", name: "x", icon: "", rdns: "x" }, provider: { request: async () => null } };
  state.solanaAccount.value = { address: "DZaZMpR6ZBNPKBqaweGnoPP3QLq3pyoRTDfBpYS1QMU2", publicKey: new Uint8Array(32), chains: [], features: [] } as WalletAccount;
  state.inspection.value = { status: "ready", value: { wrapper: { address: TOKEN, symbol: "SOL", decimals: 9 }, findings: [] } as never };
  await state.reviewRoute();
  expect(state.activeRoute.value).not.toBeNull();
}

describe("burn safety", () => {
  beforeEach(() => {
    sendBurn.mockReset();
    findings = [];
    state.burnState.value = { status: "idle" };
    vi.spyOn(state, "track").mockResolvedValue(undefined);
  });

  it("keeps the reviewed route after an explicit wallet rejection", async () => {
    await reviewed();
    sendBurn.mockRejectedValue(Object.assign(new Error("User rejected the request."), { code: 4001 }));
    await state.burn();
    expect(state.burnState.value).toMatchObject({ status: "error", message: expect.stringMatching(/rejected the request/) });
    expect(state.activeRoute.value).not.toBeNull();
  });

  it("drops the route when the wallet fails ambiguously, so a second click cannot double-burn", async () => {
    await reviewed();
    sendBurn.mockRejectedValue(new Error("Request cancelled due to timeout"));
    await state.burn();
    expect(state.burnState.value).toMatchObject({ status: "error", message: expect.stringMatching(/Check your wallet's activity/) });
    expect(state.activeRoute.value).toBeNull();
  });

  it("stops before sending, with a clear message, when the wallet stays on the wrong network", async () => {
    await reviewed();
    state.evmChainId.value = 1;
    state.evmWallet.value = { info: { uuid: "x", name: "x", icon: "", rdns: "x" }, provider: { request: async ({ method }: { method: string }) => (method === "eth_chainId" ? "0x1" : Promise.reject(new Error("switch failed"))) } };
    await state.burn();
    expect(sendBurn).not.toHaveBeenCalled();
    expect(state.burnState.value).toMatchObject({ status: "error", message: expect.stringMatching(/Nothing was sent/) });
    expect(state.activeRoute.value).not.toBeNull();
  });

  it("refuses to burn when a warning appears that the user never saw", async () => {
    await reviewed();
    findings = [{ level: "warn", code: "transfer-fee", message: "fee" }];
    await state.burn();
    expect(sendBurn).not.toHaveBeenCalled();
    expect(state.burnState.value).toMatchObject({ status: "error", message: expect.stringMatching(/new warning/) });
  });
});
