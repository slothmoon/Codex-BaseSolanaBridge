import { PublicKey } from "@solana/web3.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CONFIG } from "../config";
import { state, type EthereumProvider, type SolanaProvider } from "../shared";
import {
  connectBase,
  connectSolana,
  watchBaseAccountChanges,
  watchSolanaAccountChanges
} from "../wallets";

const originalDocument = globalThis.document;
const originalWindow = globalThis.window;

function installBrowser(input: {
  ethereum?: EthereumProvider;
  solana?: SolanaProvider;
}) {
  const elements: Record<string, HTMLElement> = {
    baseWallet: { textContent: "" } as HTMLElement,
    connectBase: { textContent: "" } as HTMLButtonElement,
    solanaWallet: { textContent: "" } as HTMLElement,
    connectSolana: { textContent: "" } as HTMLButtonElement,
    statusBox: { innerHTML: "" } as HTMLDivElement,
    burnButton: { disabled: false, hidden: false } as HTMLButtonElement,
    deriveDetails: { disabled: false, hidden: false } as HTMLButtonElement,
    derivedBox: { textContent: "" } as HTMLElement
  };

  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      visibilityState: "visible",
      addEventListener: vi.fn(),
      getElementById: (id: string) => elements[id] || null,
      querySelectorAll: () => []
    }
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      ethereum: input.ethereum,
      solana: input.solana,
      addEventListener: vi.fn(),
      setInterval: vi.fn()
    }
  });
  return elements;
}

afterEach(() => {
  state.evmAccount = "";
  state.baseReady = false;
  state.solanaAccount = "";
  state.validatedBurnKey = "";
  state.actionInFlight = false;
  Object.defineProperty(globalThis, "document", { configurable: true, value: originalDocument });
  Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
});

describe("wallet state transitions", () => {
  it("invalidates a Base route when the account or network changes", async () => {
    const listeners: Record<string, (...args: unknown[]) => void> = {};
    let chainId = `0x${CONFIG.baseChain.id.toString(16)}`;
    const firstAccount = "0x1111111111111111111111111111111111111111";
    const secondAccount = "0x2222222222222222222222222222222222222222";
    const ethereum: EthereumProvider = {
      request: vi.fn(async ({ method }) => {
        if (method === "eth_requestAccounts") return [firstAccount];
        if (method === "eth_chainId") return chainId;
        return undefined;
      }),
      on: (event, listener) => { listeners[event] = listener as (...args: unknown[]) => void; }
    };
    installBrowser({ ethereum });

    await connectBase();
    expect(state.evmAccount.toLowerCase()).toBe(firstAccount);
    expect(state.baseReady).toBe(true);

    watchBaseAccountChanges();
    state.validatedBurnKey = "validated";
    listeners.accountsChanged([secondAccount]);
    expect(state.evmAccount.toLowerCase()).toBe(secondAccount);
    expect(state.validatedBurnKey).toBe("");

    state.validatedBurnKey = "validated";
    chainId = "0x1";
    listeners.chainChanged("0x1");
    await vi.waitFor(() => expect(state.baseReady).toBe(false));
    expect(state.validatedBurnKey).toBe("");
  });

  it("invalidates a validated route when the Solana wallet changes", async () => {
    const listeners: Record<string, (...args: unknown[]) => void> = {};
    const first = new PublicKey(new Uint8Array(32).fill(0x31));
    const second = new PublicKey(new Uint8Array(32).fill(0x32));
    const provider: SolanaProvider = {
      publicKey: first,
      connect: vi.fn().mockResolvedValue({ publicKey: first }),
      on: (event, listener) => { listeners[event] = listener; }
    };
    installBrowser({ solana: provider });

    await connectSolana();
    expect(state.solanaAccount).toBe(first.toBase58());

    watchSolanaAccountChanges();
    state.validatedBurnKey = "validated";
    provider.publicKey = second;
    listeners.accountChanged(second);

    expect(state.solanaAccount).toBe(second.toBase58());
    expect(state.validatedBurnKey).toBe("");
  });
});
