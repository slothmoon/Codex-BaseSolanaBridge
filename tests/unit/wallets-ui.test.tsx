import { render, screen, fireEvent, cleanup } from "@testing-library/preact";
import { getWallets } from "@wallet-standard/app";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NETWORK } from "../../src/config";
import { discoverEvmWallets, type Eip1193Provider } from "../../src/wallets/evm";
import { discoverSolanaWallets, isUsableWallet, toSolanaSigner } from "../../src/wallets/solana";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("EVM wallet discovery (EIP-6963)", () => {
  it("lists announced wallets and drops remote icons", () => {
    const seen: string[][] = [];
    const stop = discoverEvmWallets((wallets) => seen.push(wallets.map((wallet) => `${wallet.info.name}:${wallet.info.icon ? "icon" : "none"}`)));
    const provider = { request: async () => [] } as Eip1193Provider;
    window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: { info: { uuid: "a", name: "Alpha", icon: "data:image/png;base64,AAAA", rdns: "a" }, provider } }));
    window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: { info: { uuid: "b", name: "Beta", icon: "https://evil.example/x.png", rdns: "b" }, provider } }));
    stop();
    expect(seen.at(-1)).toEqual(["Alpha:icon", "Beta:none"]);
  });

  it("falls back to window.ethereum when nothing announces", () => {
    vi.useFakeTimers();
    (window as { ethereum?: unknown }).ethereum = { request: async () => [] };
    let names: string[] = [];
    const stop = discoverEvmWallets((wallets) => (names = wallets.map((wallet) => wallet.info.name)));
    vi.advanceTimersByTime(500);
    stop();
    delete (window as { ethereum?: unknown }).ethereum;
    expect(names).toEqual(["Browser wallet"]);
  });
});

function fakeSolanaWallet(options: { chains?: string[]; versions?: (0 | 1 | "legacy")[]; sign?: boolean } = {}): Wallet & { calls: unknown[] } {
  const calls: unknown[] = [];
  const account: WalletAccount = { address: "DZaZMpR6ZBNPKBqaweGnoPP3QLq3pyoRTDfBpYS1QMU2", publicKey: new Uint8Array(32), chains: [NETWORK.solana.chain], features: [] };
  const features: Record<string, unknown> = {
    "standard:connect": { version: "1.0.0", connect: async () => ({ accounts: [account] }) },
    "standard:events": { version: "1.0.0", on: () => () => undefined }
  };
  if (options.sign !== false) {
    features["solana:signTransaction"] = {
      version: "1.0.0",
      supportedTransactionVersions: options.versions ?? ["legacy", 0],
      signTransaction: async (input: unknown) => {
        calls.push(input);
        return [{ signedTransaction: new Uint8Array([7]) }];
      }
    };
  }
  return { version: "1.0.0", name: `Fake ${Math.random()}`, icon: "data:image/svg+xml;base64,AA==", chains: (options.chains ?? [NETWORK.solana.chain]) as never, accounts: [], features: features as never, calls } as never;
}

describe("Solana wallet discovery (Wallet Standard)", () => {
  it("only offers wallets that can sign transactions on this cluster", () => {
    expect(isUsableWallet(fakeSolanaWallet())).toBe(true);
    expect(isUsableWallet(fakeSolanaWallet({ sign: false }))).toBe(false);
    expect(isUsableWallet(fakeSolanaWallet({ chains: ["solana:devnet"] }))).toBe(false);
  });

  it("discovers registered wallets", () => {
    const wallet = fakeSolanaWallet();
    let names: string[] = [];
    const stop = discoverSolanaWallets((wallets) => (names = wallets.map((item) => item.name)));
    const unregister = getWallets().register(wallet);
    expect(names).toContain(wallet.name);
    unregister();
    stop();
  });

  it("detects v1 support and signs for the right account and chain", async () => {
    const legacyOnly = fakeSolanaWallet();
    const account = { address: "DZaZMpR6ZBNPKBqaweGnoPP3QLq3pyoRTDfBpYS1QMU2", publicKey: new Uint8Array(32), chains: [NETWORK.solana.chain], features: [] } as WalletAccount;
    expect(toSolanaSigner(legacyOnly, account).supportsV1).toBe(false);
    const modern = fakeSolanaWallet({ versions: ["legacy", 0, 1] });
    const signer = toSolanaSigner(modern, account);
    expect(signer.supportsV1).toBe(true);
    expect(await signer.signTransaction(new Uint8Array([1, 2]))).toEqual(new Uint8Array([7]));
    expect(modern.calls[0]).toMatchObject({ account, chain: NETWORK.solana.chain, transaction: new Uint8Array([1, 2]) });
  });
});

describe("app shell", () => {
  it("renders, and flags an invalid token address without touching the network", async () => {
    vi.useFakeTimers();
    const { App } = await import("../../src/ui/App");
    const state = await import("../../src/state/app");
    render(<App />);
    expect(screen.getByRole("heading", { name: /Return Solana assets from Base/ })).toBeTruthy();
    const input = screen.getByPlaceholderText("0x… token address");
    fireEvent.input(input, { target: { value: "0x1234" } });
    await state.runInspection();
    expect(await screen.findByText(/valid Base token address/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Review return" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("never trusts a reviewed route after any input changes", async () => {
    const state = await import("../../src/state/app");
    const token = "0x311935Cd80B76769bF2ecC9D8Ab7635b2139cf82";
    const recipient = "DZaZMpR6ZBNPKBqaweGnoPP3QLq3pyoRTDfBpYS1QMU2";
    state.tokenInput.value = token;
    state.amountInput.value = "1";
    state.evmAccount.value = "0x0000000000000000000000000000000000000001";
    state.solanaAccount.value = { address: recipient, publicKey: new Uint8Array(32), chains: [], features: [] } as WalletAccount;
    const wrapper = { address: token, symbol: "SOL", decimals: 9 };
    state.inspection.value = { status: "ready", value: { wrapper } as never };
    const key = state.currentRouteKey.value;
    state.route.value = { status: "ready", value: { key, inspection: { wrapper } } as never };
    expect(state.activeRoute.value).not.toBeNull();

    state.amountInput.value = "2";
    expect(state.activeRoute.value).toBeNull();
    state.amountInput.value = "1";
    expect(state.activeRoute.value).not.toBeNull();
    state.solanaAccount.value = { address: "11111111111111111111111111111111", publicKey: new Uint8Array(32), chains: [], features: [] } as WalletAccount;
    expect(state.activeRoute.value).toBeNull();
  });
});
