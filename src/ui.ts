import { formatUnits, isHash, type Hex } from "viem";

import { CONFIG } from "./config";
import { STORAGE_KEY, state, type BridgeStatus, type ReturnDetails } from "./shared";

export const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

export type BusyAction = {
  buttonId: string;
  label: string;
};

export function renderApp(): void {
  document.querySelector<HTMLDivElement>("#root")!.innerHTML = `
    <main class="shell">
      <header class="topbar">
        <a class="brand" href="/" aria-label="Base to Solana bridge home">Base <span>&rarr;</span> Solana</a>
        <div class="network" id="networkBox" title="${escapeHtml(CONFIG.label)}"><span class="network-dot" aria-hidden="true"></span>${CONFIG.env === "mainnet" ? "Mainnet" : "Testnet"}</div>
      </header>

      <section class="hero">
        <h1>Return SPL tokens to Solana</h1>
        <p class="subcopy">Burn wrapped tokens on Base and claim the original SPL tokens on Solana.</p>
      </section>

      <section class="grid">
        <form class="panel" id="bridgeForm">
          <div class="panelHead">
            <span class="step">1</span>
            <div>
              <h2>Burn on Base</h2>
            </div>
          </div>

          <label>Wrapped token address
            <input id="localToken" placeholder="0x..." autocomplete="off" required />
          </label>
          <label>Amount
            <input id="amount" placeholder="0.1" inputmode="decimal" autocomplete="off" required />
          </label>
          <div class="walletButtons">
            <button type="button" id="connectBase">Connect Base wallet</button>
            <button type="button" id="connectSolana">Connect Solana wallet</button>
          </div>
          <div class="walletHints">
            <p class="hint" id="baseWallet">Base wallet not connected.</p>
            <p class="hint" id="solanaWallet">Solana wallet not connected.</p>
          </div>

          <div class="derived" id="derivedBox">
            <span class="empty-label">Route preview</span>
            <strong>Base &rarr; Solana</strong>
            <span>Connect both wallets, enter a wrapper and amount, then validate.</span>
          </div>

          <p class="irreversible-note">Base burns are irreversible. Confirm the route and destination before signing.</p>

          <div class="buttonStack">
            <button type="button" class="primary" id="deriveDetails" disabled>Validate route</button>
            <button type="submit" class="primary" id="burnButton" hidden disabled>Burn on Base</button>
          </div>
        </form>

        <section class="panel">
          <div class="panelHead">
            <span class="step">2</span>
            <div>
              <h2>Track &amp; claim</h2>
            </div>
          </div>
          <label>Base transaction hash
            <input id="txHash" placeholder="0x..." autocomplete="off" />
          </label>
          <div id="statusBox" class="status" aria-live="polite">
            <span class="empty-label">Status</span>
            <strong>No transaction selected</strong>
            <span>Paste a burn hash to check when the claim is ready.</span>
          </div>
          <div class="buttonStack claimActions">
            <button type="button" class="secondary" id="checkStatus">Check status</button>
            <button type="button" id="claim" class="primary" disabled>Claim on Solana</button>
          </div>
        </section>
      </section>

      <footer class="footer">
        <div class="risk-notice" role="note" aria-label="Risk disclaimer">
          <strong>Use at your own risk.</strong>
          <p>This self-custodial software is provided &ldquo;as is&rdquo; without warranty. Transactions are irreversible, and you are solely responsible for verifying all details before signing.</p>
        </div>
      </footer>
    </main>
  `;
}

export function invalidateBurnValidation(): void {
  state.validatedBurnKey = "";
  const burnButton = document.getElementById("burnButton") as HTMLButtonElement | null;
  const deriveButton = document.getElementById("deriveDetails") as HTMLButtonElement | null;
  if (burnButton) {
    burnButton.disabled = true;
    burnButton.hidden = true;
  }
  if (deriveButton) {
    deriveButton.hidden = false;
    deriveButton.disabled = !(state.evmAccount && state.baseReady);
  }
}

export function syncBaseActionButtons(): void {
  const baseReady = Boolean(state.evmAccount && state.baseReady);
  const claimReady = state.currentStatus?.status === "ready_to_claim" || state.currentStatus?.status === "proof_created";

  const deriveButton = document.getElementById("deriveDetails") as HTMLButtonElement | null;
  const burnButton = document.getElementById("burnButton") as HTMLButtonElement | null;
  const checkButton = document.getElementById("checkStatus") as HTMLButtonElement | null;
  const claimButton = document.getElementById("claim") as HTMLButtonElement | null;

  if (deriveButton) {
    deriveButton.disabled = !baseReady;
    deriveButton.hidden = Boolean(state.validatedBurnKey);
  }
  if (burnButton) {
    burnButton.disabled = !baseReady || !state.validatedBurnKey;
    burnButton.hidden = !state.validatedBurnKey;
  }
  if (checkButton) checkButton.disabled = false;
  if (claimButton) claimButton.disabled = !claimReady;
}

export function beginBusyAction(action: BusyAction): () => void {
  const shell = document.querySelector<HTMLElement>(".shell");
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>("button"));
  const snapshots = buttons.map((button) => ({ button, disabled: button.disabled }));
  const activeButton = document.getElementById(action.buttonId) as HTMLButtonElement | null;
  const originalLabel = activeButton?.textContent || "";

  shell?.setAttribute("aria-busy", "true");
  for (const button of buttons) button.disabled = true;
  if (activeButton) {
    activeButton.textContent = action.label;
    activeButton.classList.add("is-busy");
  }

  return () => {
    shell?.removeAttribute("aria-busy");
    for (const { button, disabled } of snapshots) button.disabled = disabled;
    if (activeButton) {
      activeButton.textContent = originalLabel;
      activeButton.classList.remove("is-busy");
    }
    syncBaseActionButtons();
  };
}

export function renderDerived(details: ReturnDetails): void {
  const token2022Warning = renderToken2022Warning(details);
  const rows: Array<[string, string, boolean?]> = [
    ["Factory verified", "Yes"],
    ["Factory", CONFIG.baseFactory, true],
    ["Official wrapper", details.localToken, true],
    ["SPL mint", details.remoteMint.toBase58(), true],
    ["Token program", details.mintInfo.tokenProgramLabel],
    ["Decimals", String(details.decimals)],
    ["Recipient wallet", state.solanaAccount, true],
    ["Recipient ATA", details.recipientTokenAccount.toBase58(), true],
    ["Bridge vault", details.tokenVault.toBase58(), true]
  ];

  if (details.amount) {
    rows.push([
      "Amount",
      `${formatUnits(details.amount, details.decimals)} ${details.symbol}`
    ]);
  }

  $("derivedBox").innerHTML = `
    ${token2022Warning}
    <div class="route-summary">
      <div><span>Token</span><strong>${escapeHtml(details.symbol)}</strong></div>
      <div><span>Amount</span><strong>${details.amount ? escapeHtml(formatUnits(details.amount, details.decimals)) : "&mdash;"}</strong></div>
      <div><span>Recipient wallet</span><strong>${escapeHtml(short(state.solanaAccount))}</strong></div>
    </div>
    <details class="technical-details">
      <summary>Technical details <span>Verified</span></summary>
      <dl class="validation-summary">
      ${rows.map(([label, value, address]) => `
        <div class="validation-row">
          <dt>${escapeHtml(label)}</dt>
          <dd${address ? ' class="address-value"' : ""}>${address ? renderCopyValue(value) : escapeHtml(value)}</dd>
        </div>
      `).join("")}
      </dl>
    </details>
  `;
}

function renderToken2022Warning(details: ReturnDetails): string {
  if (details.mintInfo.tokenProgramLabel !== "Token-2022") return "";

  return `
    <div class="token-warning">
      <strong>Token-2022 route: test with a small amount first.</strong>
      Token-2022 extensions can charge transfer fees, change the amount received, or prevent the Solana claim. This interface detects Token-2022 but cannot verify every extension.
      Confirm a small return reaches your Solana wallet before burning the rest. A failed claim does not undo the Base burn.
    </div>
  `;
}

export function renderStatus(status: BridgeStatus): void {
  const claim = $<HTMLButtonElement>("claim");
  claim.disabled = status.status !== "ready_to_claim" && status.status !== "proof_created";

  const badge = getStatusBadge(status.status);
  const progress = getProgressSteps(status.status);
  const transfer = status.transfer;

  const transactionRows: Array<[string, string, boolean?]> = [
    ["Base transaction", status.txHash, true]
  ];
  if (status.messageHash) transactionRows.push(["Message hash", status.messageHash, true]);
  if (status.incomingMessage) transactionRows.push(["Incoming proof account", status.incomingMessage.toBase58(), true]);

  const rootRows: Array<[string, string, boolean?]> = [];
  if (status.baseBlockNumber !== undefined) rootRows.push(["Base tx block", String(status.baseBlockNumber)]);
  if (status.solanaBaseBlockNumber !== undefined) rootRows.push(["Latest output-root block", String(status.solanaBaseBlockNumber)]);
  if (status.nextEligibleRootBlock !== undefined) rootRows.push(["Next eligible root", String(status.nextEligibleRootBlock)]);
  if (status.rootBlocksBehind !== undefined) rootRows.push(["Blocks remaining", `${status.rootBlocksBehind} Base blocks`]);

  const destinationRows: Array<[string, string, boolean?]> = [];
  if (transfer) {
    destinationRows.push(["SPL mint", transfer.localMint.toBase58(), true]);
    destinationRows.push(["Recipient token account", transfer.toTokenAccount.toBase58(), true]);
    destinationRows.push(["Amount", status.displayAmount || String(transfer.amount)]);
  }

  $("statusBox").innerHTML = `
    <div class="status-card">
      <div class="status-header">
        <div>
          <p class="status-kicker">Bridge status</p>
          <h3>${escapeHtml(getStatusTitle(status.status))}</h3>
          <p class="status-summary">${escapeHtml(status.humanStatus)}</p>
        </div>
        <span class="status-badge ${badge.tone}">${escapeHtml(badge.label)}</span>
      </div>

      <div class="progress-steps" aria-label="Bridge progress">
        ${progress.map((step, index) => `
          <div class="progress-step ${step.state}">
            <div class="progress-dot">${step.state === "done" ? "&#10003;" : index + 1}</div>
            <div>
              <div class="progress-label">${escapeHtml(step.label)}</div>
              <div class="progress-state">${escapeHtml(step.text)}</div>
            </div>
          </div>
        `).join("")}
      </div>

      <details class="technical-details status-details">
        <summary>Technical details <span>View</span></summary>
        <div class="status-sections">
          ${transactionRows.length ? renderStatusSection("Transaction", transactionRows) : ""}
          ${rootRows.length ? renderStatusSection("Output root", rootRows) : ""}
          ${destinationRows.length ? renderStatusSection("Destination", destinationRows) : ""}
        </div>
      </details>
    </div>
  `;
  syncBaseActionButtons();
}

export function setStatus(message: string, tone: "info" | "success" | "error" = "info"): void {
  $("statusBox").innerHTML = `
    <div class="status-message ${tone}">${escapeHtml(message).replace(/\n/g, "<br>")}</div>
  `;
}

export function setLinkedStatus(
  message: string,
  linkLabel: string,
  href: string,
  tone: "info" | "success" = "success"
): void {
  $("statusBox").innerHTML = `
    <div class="status-message ${tone}">
      ${escapeHtml(message).replace(/\n/g, "<br>")}
      <a class="explorer-link" href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${escapeHtml(linkLabel)} &rarr;</a>
    </div>
  `;
}

export function showError(error: unknown): void {
  setStatus(errorMessage(error), "error");
}

export async function copyValue(value: string): Promise<void> {
  if (!value) return;
  await navigator.clipboard.writeText(value);
  showToast(`Copied ${short(value)}`);
}

export function renderCopyValue(value: string): string {
  return `<button type="button" class="copy-chip" data-copy-value="${escapeHtml(value)}" title="Click to copy full value" aria-label="Copy ${escapeHtml(value)}">${escapeHtml(short(value))}</button>`;
}

export function readTxHash(): Hex {
  const value = ($<HTMLInputElement>("txHash").value.trim() || state.currentTxHash) as string;
  if (!isHash(value)) throw new Error("Paste a valid 0x-prefixed Base transaction hash.");
  rememberTx(value);
  return value;
}

export function rememberTx(txHash: Hex): void {
  state.currentTxHash = txHash;
  $<HTMLInputElement>("txHash").value = txHash;
  try {
    localStorage.setItem(STORAGE_KEY, txHash);
  } catch {
    // Remembering the last tx is a convenience; bridge actions must not depend on browser storage.
  }
}

export function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/over rate limit|rate limit|too many requests|\b429\b/i.test(message)) {
    return [
      "The Base RPC is temporarily rate limited. No transaction was submitted and no tokens moved.",
      "Connect your Base wallet and retry so the page can use the wallet RPC.",
      "For a public deployment, set VITE_BASE_RPC_URLS in Vercel to one or more browser-compatible production Base RPC URLs separated by commas."
    ].join("\n");
  }
  return message;
}

export function formatSolanaFailure(prefix: string, reason: unknown, logs?: string[] | null): string {
  const reasonText = typeof reason === "string" ? reason : JSON.stringify(reason);
  const friendly = getFriendlySolanaError(logs, reasonText);
  return `${friendly ? `${friendly}\n\n` : ""}${prefix}: ${reasonText}${formatLogs(logs)}`;
}

export async function formatSolanaError(prefix: string, error: unknown, getLogsConnection: unknown): Promise<string> {
  const candidate = error as {
    logs?: string[];
    getLogs?: (connection?: unknown) => string[] | Promise<string[]>;
  };
  let logs = candidate.logs;
  if (!logs && candidate.getLogs) {
    try {
      logs = await candidate.getLogs(getLogsConnection);
    } catch {
      // Keep the original wallet or RPC error if log retrieval also fails.
    }
  }
  const friendly = getFriendlySolanaError(logs, errorMessage(error));
  return `${friendly ? `${friendly}\n\n` : ""}${prefix}: ${errorMessage(error)}${formatLogs(logs)}`;
}

export function lamportsToSol(value: bigint): string {
  const whole = value / 1_000_000_000n;
  const fractional = (value % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
  return fractional ? `${whole}.${fractional}` : whole.toString();
}

export function short(value: string): string {
  return value.length > 14 ? `${value.slice(0, 6)}...${value.slice(-6)}` : value;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;"
  })[character] || character);
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;

function showToast(message: string): void {
  let toast = document.getElementById("copyToast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "copyToast";
    toast.className = "copy-toast";
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add("visible");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast?.classList.remove("visible"), 1600);
}

function renderStatusSection(title: string, rows: Array<[string, string, boolean?]>): string {
  return `
    <section class="status-section">
      <h4>${escapeHtml(title)}</h4>
      <dl class="status-detail-list">
        ${rows.map(([label, value, address]) => `
          <div class="status-detail-row">
            <dt>${escapeHtml(label)}</dt>
            <dd${address ? ' class="address-value"' : ""}>${address ? renderCopyValue(value) : escapeHtml(value)}</dd>
          </div>
        `).join("")}
      </dl>
    </section>
  `;
}

function getStatusTitle(status: BridgeStatus["status"]): string {
  switch (status) {
    case "waiting_for_base_tx":
      return "Waiting for Base transaction";
    case "not_bridge_tx":
      return "Bridge event not found";
    case "waiting_for_root":
      return "Waiting for output root";
    case "ready_to_claim":
      return "Ready to claim";
    case "proof_created":
      return "Ready to relay";
    case "claimed":
      return "Claim confirmed";
  }
}

function getStatusBadge(status: BridgeStatus["status"]): { label: string; tone: string } {
  switch (status) {
    case "waiting_for_base_tx":
      return { label: "Waiting", tone: "neutral" };
    case "not_bridge_tx":
      return { label: "Issue", tone: "danger" };
    case "waiting_for_root":
      return { label: "Waiting for root", tone: "warning" };
    case "ready_to_claim":
      return { label: "Ready", tone: "success" };
    case "proof_created":
      return { label: "Relay retry", tone: "info" };
    case "claimed":
      return { label: "Confirmed", tone: "success" };
  }
}

function getProgressSteps(status: BridgeStatus["status"]): Array<{ label: string; text: string; state: "done" | "current" | "upcoming" }> {
  if (status === "waiting_for_root") {
    return [
      { label: "Burn on Base", text: "Complete", state: "done" },
      { label: "Wait for output root", text: "In progress", state: "current" },
      { label: "Claim on Solana", text: "Locked", state: "upcoming" }
    ];
  }
  if (status === "ready_to_claim") {
    return [
      { label: "Burn on Base", text: "Complete", state: "done" },
      { label: "Wait for output root", text: "Complete", state: "done" },
      { label: "Claim on Solana", text: "Ready now", state: "current" }
    ];
  }
  if (status === "proof_created") {
    return [
      { label: "Burn on Base", text: "Complete", state: "done" },
      { label: "Wait for output root", text: "Complete", state: "done" },
      { label: "Claim on Solana", text: "Retry relay", state: "current" }
    ];
  }
  if (status === "claimed") {
    return [
      { label: "Burn on Base", text: "Complete", state: "done" },
      { label: "Wait for output root", text: "Complete", state: "done" },
      { label: "Claim on Solana", text: "Confirmed", state: "done" }
    ];
  }
  if (status === "not_bridge_tx") {
    return [
      { label: "Burn on Base", text: "Transaction found", state: "current" },
      { label: "Wait for output root", text: "Unavailable", state: "upcoming" },
      { label: "Claim on Solana", text: "Unavailable", state: "upcoming" }
    ];
  }
  return [
    { label: "Burn on Base", text: "Waiting", state: "current" },
    { label: "Wait for output root", text: "Not started", state: "upcoming" },
    { label: "Claim on Solana", text: "Not started", state: "upcoming" }
  ];
}

function getFriendlySolanaError(logs?: string[] | null, reason = ""): string {
  if (/InsufficientFundsForRent/i.test(reason)) {
    return "Your Solana wallet still needs more SOL for rent and fees. Add a little more SOL, then retry the same Base transaction hash. No extra Base burn is needed.";
  }

  const insufficient = logs?.find((log) => log.includes("Transfer: insufficient lamports"));
  if (!insufficient) return "";
  const match = insufficient.match(/insufficient lamports (\d+), need (\d+)/);
  if (!match) return "Your Solana wallet needs more SOL to pay account rent and transaction fees. Add SOL, then retry.";
  const current = BigInt(match[1]);
  const needed = BigInt(match[2]);
  return `Your Solana wallet has about ${lamportsToSol(current)} SOL available at the failing instruction, but needs at least ${lamportsToSol(needed)} SOL plus transaction fees. Add a little more SOL, then retry the same Base transaction hash.`;
}

function formatLogs(logs?: string[] | null): string {
  return logs?.length ? `\n\nLogs:\n${logs.join("\n")}` : "";
}
