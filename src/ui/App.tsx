import { NETWORK } from "../config";
import { upgradedComponents, walletError } from "../state/app";
import { Notice } from "./components";
import { ReturnCard } from "./ReturnCard";
import { TrackCard } from "./TrackCard";
import { WalletBar } from "./WalletBar";

export function App() {
  return (
    <div class="shell">
      <header class="topbar">
        <a class="brand" href="./" aria-label="Base to Solana return, home">
          <svg viewBox="0 0 32 32" aria-hidden="true" class="brand-mark">
            <circle cx="10" cy="16" r="7" class="brand-base" />
            <path d="M17 16h9m-3.5-3.5L26 16l-3.5 3.5" class="brand-arrow" />
          </svg>
          <span>Base <span class="muted">→</span> Solana</span>
        </a>
        <span class={`network-pill ${NETWORK.id === "mainnet" ? "" : "is-testnet"}`}>{NETWORK.id === "mainnet" ? "Mainnet" : "Testnet"}</span>
        <WalletBar />
      </header>

      <main>
        {upgradedComponents.value.length > 0 && (
          <Notice tone="warn" title="The bridge was upgraded after this interface was verified">
            Changed: {upgradedComponents.value.join(", ")}. Existing safety checks still run, but consider waiting for this interface to be re-verified before burning large amounts.
          </Notice>
        )}
        {walletError.value && <Notice tone="danger">{walletError.value}</Notice>}

        <div class="hero">
          <h1>Return Solana assets from Base</h1>
          <p class="muted">
            Burn Base-wrapped SPL tokens or SOL and receive the originals on Solana. Everything runs in your browser against public RPCs — no backend, no custody.
          </p>
        </div>

        <div class="grid">
          <ReturnCard />
          <TrackCard />
        </div>
      </main>

      <footer class="footer">
        <p>
          <strong>Use at your own risk.</strong> This open-source, self-custodial software is provided as is. Transactions are irreversible; verify every detail before signing.
        </p>
        <p class="muted">
          Built on the official <a href="https://docs.base.org/base-chain/quickstart/base-solana-bridge" target="_blank" rel="noreferrer noopener">Base–Solana bridge</a>. Not affiliated with Base or Coinbase.
        </p>
      </footer>
    </div>
  );
}
