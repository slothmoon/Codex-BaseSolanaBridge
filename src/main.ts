import { Buffer } from "buffer";
import { isHash } from "viem";

import { previewReturn, startBridge } from "./burn";
import { checkStatus, claimOnSolana } from "./bridge-status";
import { STORAGE_KEY, state } from "./shared";
import {
  $,
  copyValue,
  invalidateBurnValidation,
  renderApp,
  setStatus,
  showError
} from "./ui";
import {
  connectBase,
  connectSolana,
  restoreBaseConnection,
  restoreSolanaConnection,
  watchBaseAccountChanges,
  watchSolanaAccountChanges
} from "./wallets";
import "./styles.css";

(globalThis as typeof globalThis & { Buffer?: typeof Buffer }).Buffer = Buffer;

renderApp();
init().catch(showError);

async function init(): Promise<void> {
  $("connectBase").addEventListener("click", () => runSafely(connectBase));
  $("connectSolana").addEventListener("click", () => runSafely(connectSolana));
  $("deriveDetails").addEventListener("click", () => runSafely(previewReturn));
  $("bridgeForm").addEventListener("submit", (event) => runSafely(() => startBridge(event)));
  $("checkStatus").addEventListener("click", () => runSafely(checkStatus));
  $("claim").addEventListener("click", () => runSafely(claimOnSolana));
  document.addEventListener("click", (event) => {
    const target = event.target as HTMLElement | null;
    const copyable = target?.closest<HTMLElement>("[data-copy-value]");
    if (!copyable) return;
    void runSafely(() => copyValue(copyable.dataset.copyValue || ""));
  });
  $<HTMLInputElement>("localToken").addEventListener("input", () => invalidateBurnValidation());
  $<HTMLInputElement>("amount").addEventListener("input", () => invalidateBurnValidation());

  await restoreBaseConnection();
  restoreSolanaConnection();
  watchBaseAccountChanges();
  watchSolanaAccountChanges();

  const queryTx = new URLSearchParams(location.search).get("tx");
  const savedTx = localStorage.getItem(STORAGE_KEY);
  const txHash = queryTx || savedTx || "";
  if (txHash && isHash(txHash)) {
    state.currentTxHash = txHash;
    $<HTMLInputElement>("txHash").value = txHash;
    setStatus("Saved Base transaction loaded. Click Check status.");
  }
}

async function runSafely(task: () => Promise<unknown>): Promise<void> {
  if (state.actionInFlight) return;
  state.actionInFlight = true;
  try {
    await task();
  } catch (error) {
    showError(error);
  } finally {
    state.actionInFlight = false;
  }
}
