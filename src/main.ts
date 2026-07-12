import { Buffer } from "buffer";
import { previewReturn, startBridge } from "./burn";
import { checkStatus } from "./bridge-status";
import { claimOnSolana } from "./claim";
import { STORAGE_KEY, state } from "./shared";
import {
  $,
  beginBusyAction,
  copyValue,
  invalidateBurnValidation,
  invalidateClaimStatus,
  rememberTx,
  renderApp,
  selectInitialTxHash,
  setStatus,
  showError,
  type BusyAction
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
  $("connectBase").addEventListener("click", () => runSafely(connectBase, { buttonId: "connectBase", label: "Connecting..." }));
  $("connectSolana").addEventListener("click", () => runSafely(connectSolana, { buttonId: "connectSolana", label: "Connecting..." }));
  $("deriveDetails").addEventListener("click", () => runSafely(previewReturn, { buttonId: "deriveDetails", label: "Validating..." }));
  $("bridgeForm").addEventListener("submit", (event) => {
    event.preventDefault();
    void runSafely(startBridge, { buttonId: "burnButton", label: "Burning..." });
  });
  $("checkStatus").addEventListener("click", () => runSafely(checkStatus, { buttonId: "checkStatus", label: "Checking..." }));
  $("claim").addEventListener("click", () => runSafely(claimOnSolana, { buttonId: "claim", label: "Claiming..." }));
  document.addEventListener("click", (event) => {
    const target = event.target as HTMLElement | null;
    const copyable = target?.closest<HTMLElement>("[data-copy-value]");
    if (!copyable) return;
    void runSafely(() => copyValue(copyable.dataset.copyValue || ""));
  });
  $<HTMLInputElement>("localToken").addEventListener("input", () => invalidateBurnValidation());
  $<HTMLInputElement>("amount").addEventListener("input", () => invalidateBurnValidation());
  $<HTMLInputElement>("txHash").addEventListener("input", () => invalidateClaimStatus());

  await restoreBaseConnection();
  restoreSolanaConnection();
  watchBaseAccountChanges();
  watchSolanaAccountChanges();

  const queryTx = new URLSearchParams(location.search).get("tx");
  const savedTx = readSavedTx();
  const txHash = selectInitialTxHash(queryTx, savedTx);
  if (txHash) {
    rememberTx(txHash);
    setStatus("Saved Base transaction loaded. Click Check status.");
  }
  if (queryTx) cleanTxQueryParam();
}

function readSavedTx(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

function cleanTxQueryParam(): void {
  const url = new URL(location.href);
  url.searchParams.delete("tx");
  const query = url.searchParams.toString();
  history.replaceState(null, "", `${url.pathname}${query ? `?${query}` : ""}${url.hash}`);
}

async function runSafely(task: () => Promise<unknown>, action?: BusyAction): Promise<void> {
  if (state.actionInFlight) return;
  state.actionInFlight = true;
  const endBusy = action ? beginBusyAction(action) : null;
  try {
    await task();
  } catch (error) {
    showError(error);
  } finally {
    state.actionInFlight = false;
    endBusy?.();
  }
}
