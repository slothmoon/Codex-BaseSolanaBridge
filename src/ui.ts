import { formatUnits, isHash, type Hex } from "viem";

import { CONFIG } from "./config";
import { STORAGE_KEY, state, type BridgeStatus, type ReturnDetails } from "./shared";

const BUILD_ID = "token2022-guard-v14";

export const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

export function renderApp(): void {
  document.querySelector<HTMLDivElement>("#root")!.innerHTML = `
    <main class="shell">
      <section class="hero">
        <div>
          <p class="eyebrow">Base &rarr; Solana</p>
          <h1>Return bridged SPL tokens to Solana</h1>
          <p class="subcopy">A static, non-custodial interface. Your browser reads both chains, builds the proof transaction, and asks your wallets to sign.</p>
        </div>
        <div class="network" id="networkBox">${escapeHtml(CONFIG.label)}</div>
      </section>

      <section class="security-note">
        <strong>No backend and no database.</strong>
        This page never receives private keys or funds. Keep your Base transaction hash so you can return and claim later.
      </section>

      <section class="grid">
        <form class="panel" id="bridgeForm">
          <div class="panelHead">
            <span class="step">1</span>
            <div>
              <h2>Burn the Base wrapper</h2>
              <p>The page validates the official wrapper, mint, decimals, token program, bridge vault, balance, and Base simulation first.</p>
            </div>
          </div>

          <label>Base wrapped SPL token address
            <input id="localToken" placeholder="0x..." autocomplete="off" required />
          </label>
          <label>Amount
            <input id="amount" placeholder="0.1" inputmode="decimal" autocomplete="off" required />
          </label>
          <div class="derived" id="derivedBox">Connect both wallets, enter a wrapper and amount, then preview the destination.</div>

          <div class="buttonRow">
            <button type="button" id="connectBase">Connect Base wallet</button>
            <button type="button" id="connectSolana">Connect Solana wallet</button>
            <button type="button" id="deriveDetails">Validate and preview</button>
            <button type="submit" class="primary" id="burnButton" disabled>Burn on Base</button>
          </div>
          <p class="hint" id="baseWallet">Base wallet not connected.</p>
          <p class="hint" id="solanaWallet">Solana wallet not connected.</p>
        </form>

        <section class="panel">
          <div class="panelHead">
            <span class="step">2</span>
            <div>
              <h2>Track and claim</h2>
              <p>Paste the Base burn transaction hash, or use the one saved in this browser.</p>
            </div>
          </div>
          <label>Base transaction hash
            <input id="txHash" placeholder="0x..." autocomplete="off" />
          </label>
          <div class="buttonRow">
            <button type="button" id="checkStatus">Check status</button>
            <button type="button" id="claim" class="primary" disabled>Claim on Solana</button>
          </div>
          <div id="statusBox" class="status">No transaction selected.</div>
        </section>
      </section>

      <section class="notes">
        <h2>How the return works</h2>
        <ol>
          <li>Your Base wallet burns the official wrapped SPL ERC-20 and emits a bridge message.</li>
          <li>Validators register a Base output root on Solana.</li>
          <li>Your browser generates the MMR proof and builds the Solana prove + relay transaction.</li>
          <li>Your Solana wallet pays network fees and account rent, signs, and receives the unlocked SPL token in its ATA.</li>
        </ol>
      </section>

      <footer class="build-footer">Build ${BUILD_ID}</footer>
    </main>
  `;
}

export function invalidateBurnValidation(): void {
  state.validatedBurnKey = "";
  const burnButton = document.getElementById("burnButton") as HTMLButtonElement | null;
  if (burnButton) burnButton.disabled = true;
}

export function renderDerived(details: ReturnDetails): void {
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

  if (details.mintInfo.token2022Extensions.length) {
    rows.push([
      "Token-2022 extensions",
      details.mintInfo.token2022Extensions.map((extension) => extension.name).join(", ")
    ]);
  }

  if (details.amount) {
    rows.push([
      "Amount",
      `${formatUnits(details.amount, details.decimals)} ${details.symbol}`
    ]);
  }

  $("derivedBox").innerHTML = `
    <dl class="validation-summary">
      ${rows.map(([label, value, address]) => `
        <div class="validation-row">
          <dt>${escapeHtml(label)}</dt>
          <dd${address ? ' class="address-value"' : ""}>${address ? renderCopyValue(value) : escapeHtml(value)}</dd>
        </div>
      `).join("")}
    </dl>
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
    if (state.solanaAccount) destinationRows.push(["Recipient wallet", state.solanaAccount, true]);
    destinationRows.push(["Recipient ATA", transfer.toTokenAccount.toBase58(), true]);
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

      <div class="status-sections">
        ${transactionRows.length ? renderStatusSection("Transaction", transactionRows) : ""}
        ${rootRows.length ? renderStatusSection("Output root", rootRows) : ""}
        ${destinationRows.length ? renderStatusSection("Destination", destinationRows) : ""}
      </div>
    </div>
  `;
}

export function setStatus(message: string, tone: "info" | "success" | "error" = "info"): void {
  $("statusBox").innerHTML = `
    <div class="status-message ${tone}">${escapeHtml(message).replace(/\n/g, "<br>")}</div>
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
  localStorage.setItem(STORAGE_KEY, txHash);
  const url = new URL(location.href);
  url.searchParams.set("tx", txHash);
  history.replaceState(null, "", url);
}

export function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/over rate limit|rate limit|too many requests|\b429\b/i.test(message)) {
    return [
      "The Base RPC is temporarily rate limited. No transaction was submitted and no tokens moved.",
      "Connect your Base wallet and retry so the page can use the wallet RPC.",
      "For a public deployment, set VITE_BASE_RPC_URLS in Cloudflare Pages to one or more browser-compatible production Base RPC URLs separated by commas."
    ].join("\n");
  }
  return message;
}

export function formatSolanaFailure(prefix: string, reason: unknown, logs?: string[] | null): string {
  const friendly = getFriendlySolanaError(logs);
  const reasonText = typeof reason === "string" ? reason : JSON.stringify(reason);
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
  const friendly = getFriendlySolanaError(logs);
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

function getFriendlySolanaError(logs?: string[] | null): string {
  const insufficient = logs?.find((log) => log.includes("Transfer: insufficient lamports"));
  if (!insufficient) return "";
  const match = insufficient.match(/insufficient lamports (\d+), need (\d+)/);
  if (!match) return "Your Solana wallet needs more SOL to pay account rent and transaction fees. Add SOL, then retry.";
  const current = BigInt(match[1]);
  const needed = BigInt(match[2]);
  return `Your Solana wallet has about ${lamportsToSol(current)} SOL available at the failing instruction, but needs at least ${lamportsToSol(needed)} SOL plus transaction fees. Add roughly 0.005 SOL, then retry the same Base transaction hash.`;
}

function formatLogs(logs?: string[] | null): string {
  return logs?.length ? `\n\nLogs:\n${logs.join("\n")}` : "";
}
