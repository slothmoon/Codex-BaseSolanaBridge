import { useState } from "preact/hooks";

import { NETWORK } from "../config";
import {
  connectEvm,
  connectSolana,
  disconnectEvm,
  disconnectSolana,
  evmAccount,
  evmOnBase,
  evmWallet,
  evmWallets,
  solanaAddress,
  solanaWallet,
  solanaWallets,
  switchEvmToBase
} from "../state/app";
import { Dialog, Icon } from "./components";
import { shortAddress } from "./format";

type Picker = "evm" | "solana" | null;

export function WalletBar() {
  const [picker, setPicker] = useState<Picker>(null);
  const close = () => setPicker(null);

  return (
    <div class="wallet-bar">
      <WalletChip
        chain="Base"
        connected={Boolean(evmAccount.value)}
        label={evmAccount.value ? shortAddress(evmAccount.value) : "Connect Base"}
        icon={evmWallet.value?.info.icon}
        warning={evmAccount.value && !evmOnBase.value ? `Switch to ${NETWORK.base.chain.name}` : null}
        onWarning={() => void switchEvmToBase()}
        onClick={() => setPicker("evm")}
      />
      <WalletChip
        chain="Solana"
        connected={Boolean(solanaAddress.value)}
        label={solanaAddress.value ? shortAddress(solanaAddress.value) : "Connect Solana"}
        icon={solanaWallet.value?.icon}
        onClick={() => setPicker("solana")}
      />

      <Dialog open={picker === "evm"} title="Base wallet" onClose={close}>
        {evmAccount.value && (
          <div class="dialog-connected">
            <span>Connected as <code>{shortAddress(evmAccount.value, 6, 6)}</code></span>
            <button type="button" class="button button-ghost" onClick={() => { disconnectEvm(); close(); }}>Disconnect</button>
          </div>
        )}
        <WalletList
          wallets={evmWallets.value.map((wallet) => ({ id: wallet.info.uuid, name: wallet.info.name, icon: wallet.info.icon, active: evmWallet.value?.info.uuid === wallet.info.uuid, connect: () => connectEvm(wallet) }))}
          empty="No Base wallet found. Install a browser wallet such as Coinbase Wallet, Rabby or MetaMask, then reload."
          onDone={close}
        />
      </Dialog>

      <Dialog open={picker === "solana"} title="Solana wallet" onClose={close}>
        {solanaAddress.value && (
          <div class="dialog-connected">
            <span>Connected as <code>{shortAddress(solanaAddress.value, 6, 6)}</code></span>
            <button type="button" class="button button-ghost" onClick={() => { void disconnectSolana(); close(); }}>Disconnect</button>
          </div>
        )}
        <WalletList
          wallets={solanaWallets.value.map((wallet) => ({ id: wallet.name, name: wallet.name, icon: wallet.icon, active: solanaWallet.value?.name === wallet.name, connect: () => connectSolana(wallet) }))}
          empty="No Solana wallet found. Install a wallet such as Phantom, Solflare or Backpack, then reload."
          onDone={close}
        />
      </Dialog>
    </div>
  );
}

function WalletChip(props: { chain: string; connected: boolean; label: string; icon?: string; warning?: string | null; onWarning?: () => void; onClick: () => void }) {
  return (
    <div class="wallet-chip-group">
      <button type="button" class={`wallet-chip ${props.connected ? "is-connected" : ""}`} onClick={props.onClick}>
        {props.icon ? <img src={props.icon} alt="" width={18} height={18} /> : <Icon name="wallet" />}
        {props.connected && <span class="wallet-chip-chain">{props.chain}</span>}
        <span class="wallet-chip-label">{props.label}</span>
      </button>
      {props.warning && (
        <button type="button" class="wallet-chip-warning" onClick={props.onWarning}>
          <Icon name="alert" />
          {props.warning}
        </button>
      )}
    </div>
  );
}

function WalletList(props: { wallets: { id: string; name: string; icon: string; active: boolean; connect: () => Promise<void> }[]; empty: string; onDone: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  if (props.wallets.length === 0) return <p class="muted">{props.empty}</p>;
  return (
    <ul class="wallet-list">
      {props.wallets.map((wallet) => (
        <li key={wallet.id}>
          <button
            type="button"
            class={`wallet-option ${wallet.active ? "is-active" : ""}`}
            disabled={busy !== null}
            onClick={async () => {
              setBusy(wallet.id);
              await wallet.connect();
              setBusy(null);
              props.onDone();
            }}
          >
            {wallet.icon ? <img src={wallet.icon} alt="" width={28} height={28} /> : <span class="wallet-fallback-icon"><Icon name="wallet" /></span>}
            <span>{wallet.name}</span>
            {busy === wallet.id ? <span class="muted">Waiting for wallet…</span> : wallet.active ? <span class="pill">Connected</span> : null}
          </button>
        </li>
      ))}
    </ul>
  );
}
