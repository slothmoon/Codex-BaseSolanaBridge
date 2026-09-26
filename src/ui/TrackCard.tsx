import type { Hex } from "viem";

import { baseExplorerTx, solanaExplorerAccount, solanaExplorerTx } from "../config";
import type { TrackStatus, TrackedTransfer } from "../core/status";
import {
  claimPrep,
  claimProgress,
  claimRun,
  history,
  removeFromHistory,
  reviewClaim,
  runClaim,
  solanaAddress,
  track,
  tracked,
  trackedSince,
  trackInput
} from "../state/app";
import { ErrorNotice, Findings, Icon, Mono, Notice, Row, Spinner } from "./components";
import { formatAmount, formatDuration, formatSol, timeAgo } from "./format";

export function TrackCard() {
  return (
    <section class="card" aria-labelledby="track-title">
      <header class="card-header">
        <span class="step-badge">2</span>
        <div>
          <h2 id="track-title">Track &amp; claim</h2>
          <p class="muted">Paste any Base burn transaction to see where it is and finish the claim.</p>
        </div>
      </header>

      <form
        class="field"
        onSubmit={(event) => {
          event.preventDefault();
          void track();
        }}
      >
        <span class="field-label">Base transaction hash</span>
        <div class="input-row">
          <input
            value={trackInput.value}
            onInput={(event) => (trackInput.value = event.currentTarget.value)}
            placeholder="0x…"
            spellcheck={false}
            autocomplete="off"
          />
          <button type="submit" class="button button-secondary" disabled={tracked.value.status === "loading"}>
            Track
          </button>
        </div>
      </form>

      {tracked.value.status === "loading" && <Spinner label="Reading Base and Solana…" />}
      {tracked.value.status === "error" && <ErrorNotice message={tracked.value.message} detail={tracked.value.detail} />}
      {tracked.value.status === "ready" && <StatusView status={tracked.value.value} />}

      <HistoryList />
    </section>
  );
}

function StatusView({ status }: { status: TrackStatus }) {
  switch (status.state) {
    case "not-found": {
      const waited = trackedSince.value ? Date.now() - trackedSince.value : 0;
      return (
        <Notice tone={waited > 120_000 ? "warn" : "info"} title="Transaction not found on Base yet">
          {waited > 120_000
            ? "Still nothing after a couple of minutes. Check the hash for typos and make sure it is a Base transaction."
            : "If you just submitted it, it can take a few seconds to appear. This checks again automatically."}
        </Notice>
      );
    }
    case "reverted":
      return <Notice tone="danger" title="This Base transaction reverted">Nothing was burned, so there is nothing to claim.</Notice>;
    case "not-a-bridge-tx":
      return (
        <Notice tone="warn" title="Not a bridge burn">
          {status.reason === "no-event"
            ? "This transaction did not send a message through the official Base → Solana bridge."
            : "This transaction sent more than one bridge message, which this interface does not handle."}
        </Notice>
      );
    case "unsupported":
      return (
        <Notice tone="info" title={status.executed ? "Executed on Solana" : "Tracked only"}>
          {status.reason}
        </Notice>
      );
    default:
      return <TransferView status={status} />;
  }
}

function TransferView({ status }: { status: TrackedTransfer & { state: "waiting-for-root" | "ready" | "proven" | "claimed"; eta?: { seconds: number; eligibleRootBlock: bigint } } }) {
  const amount = `${formatAmount(status.transfer.amount, status.asset.decimals, 9)} ${status.asset.symbol}`;
  const paused = status.bridge.paused && status.state !== "claimed";
  const steps = [
    { label: "Burned on Base", done: true, detail: `Block ${status.baseBlock.toLocaleString()}` },
    {
      label: "Output root on Solana",
      done: status.state !== "waiting-for-root",
      detail: status.state === "waiting-for-root" && status.eta ? `Expected in ${formatDuration(status.eta.seconds)}` : "Available"
    },
    {
      label: "Claimed on Solana",
      done: status.state === "claimed",
      detail: status.state === "claimed" ? "Complete" : status.state === "proven" ? "Proven — release pending" : "Pending"
    }
  ];
  const current = steps.findIndex((step) => !step.done);

  return (
    <div class="status">
      <div class="status-head">
        <div>
          <p class="eyebrow">{status.transfer.kind === "sol" ? "SOL return" : "Token return"}</p>
          <h3>{amount}</h3>
        </div>
        <StatusPill state={status.state} paused={paused} />
      </div>

      <ol class="timeline">
        {steps.map((step, index) => (
          <li key={step.label} class={step.done ? "is-done" : index === current ? "is-current" : ""}>
            <span class="timeline-dot">{step.done ? <Icon name="check" /> : index + 1}</span>
            <div>
              <strong>{step.label}</strong>
              <span class="muted">{step.detail}</span>
            </div>
          </li>
        ))}
      </ol>

      {paused && <Notice tone="warn" title="The Solana side of the bridge is paused">Your funds are safe. Claiming resumes when the bridge is unpaused.</Notice>}
      {status.state === "waiting-for-root" && !paused && (
        <p class="muted small">The claim unlocks once Base finalizes your burn and an output root covering it reaches Solana, typically 20–35 minutes after the burn. This page checks automatically.</p>
      )}

      {(status.state === "ready" || status.state === "proven") && !paused && <ClaimPanel />}

      <details class="technical">
        <summary>Details</summary>
        <dl class="rows">
          <Row label="Base transaction"><Mono value={status.txHash} href={baseExplorerTx(status.txHash)} /></Row>
          <Row label="Recipient">{<Mono value={status.transfer.to} href={solanaExplorerAccount(status.transfer.to)} />}</Row>
          {status.transfer.kind !== "sol" && <Row label="Mint"><Mono value={status.transfer.mint} href={solanaExplorerAccount(status.transfer.mint)} /></Row>}
          <Row label="Message nonce">{status.event.nonce.toString()}</Row>
          <Row label="Message hash"><Mono value={status.event.messageHash} /></Row>
          <Row label="Proof account"><Mono value={status.incomingMessage} href={solanaExplorerAccount(status.incomingMessage)} /></Row>
          <Row label="Latest root block">{status.bridge.baseBlockNumber.toLocaleString()}</Row>
        </dl>
      </details>
    </div>
  );
}

function StatusPill({ state, paused }: { state: string; paused: boolean }) {
  if (paused) return <span class="pill pill-warn">Paused</span>;
  const map: Record<string, [string, string]> = {
    "waiting-for-root": ["Waiting", "pill-neutral"],
    ready: ["Ready to claim", "pill-accent"],
    proven: ["Ready to release", "pill-accent"],
    claimed: ["Claimed", "pill-success"]
  };
  const [label, tone] = map[state] ?? [state, "pill-neutral"];
  return <span class={`pill ${tone}`}>{label}</span>;
}

function ClaimPanel() {
  const prep = claimPrep.value;
  const run = claimRun.value;

  if (!solanaAddress.value) {
    return <Notice tone="info">Connect a Solana wallet to claim. Any wallet can pay for the claim; the funds always go to the recipient fixed at burn time.</Notice>;
  }

  if (run.status === "loading") {
    return (
      <div class="claim-panel" aria-live="polite">
        <h4>Claiming</h4>
        <ol class="claim-steps">
          {claimProgress.value.map((step) => (
            <li key={step.index} class={step.phase === "confirmed" ? "is-done" : ""}>
              <span>{step.index + 1}/{step.total} · {step.label}</span>
              <span class="muted">{phaseLabel(step.phase)}</span>
              {step.signature && <a href={solanaExplorerTx(step.signature)} target="_blank" rel="noreferrer noopener" class="icon-button" aria-label="View on Solana Explorer"><Icon name="external" /></a>}
            </li>
          ))}
        </ol>
        {claimProgress.value.length === 0 && <Spinner label="Preparing…" />}
      </div>
    );
  }

  return (
    <div class="claim-panel">
      {run.status === "error" && <ErrorNotice message={run.message} detail={run.detail} />}
      {run.status === "ready" && (
        <Notice tone="success" title={run.value.alreadyClaimed ? "Someone else completed the claim" : "Claim complete"}>
          {run.value.signatures.map((signature) => <div key={signature}><Mono value={signature} href={solanaExplorerTx(signature)} /></div>)}
        </Notice>
      )}

      {prep.status === "idle" && (
        <button type="button" class="button button-primary" onClick={() => void reviewClaim()}>
          Review claim
        </button>
      )}
      {prep.status === "loading" && <Spinner label="Generating and checking the proof…" />}
      {prep.status === "error" && (
        <>
          <ErrorNotice message={prep.message} detail={prep.detail} />
          <button type="button" class="button button-secondary" onClick={() => void reviewClaim()}>Try again</button>
        </>
      )}
      {prep.status === "ready" && (
        <>
          <h4>Claim plan</h4>
          <ol class="claim-steps">
            {prep.value.plan.txs.map((tx, index) => (
              <li key={index}><span>{index + 1}. {tx.label}</span></li>
            ))}
          </ol>
          <dl class="rows">
            <Row label="Transactions to sign">{prep.value.plan.txs.length}{prep.value.plan.version === 1 ? " (large-transaction format)" : ""}</Row>
            <Row label="Network fees">≈ {formatSol(prep.value.cost.networkFees)}</Row>
            {prep.value.cost.newAccountRent > 0n && <Row label="Account rent">{formatSol(prep.value.cost.newAccountRent)}</Row>}
            {prep.value.cost.refundableRent > 0n && <Row label="Temporary deposit">{formatSol(prep.value.cost.refundableRent)} (refunded)</Row>}
            <Row label="Paid by">{<Mono value={prep.value.payer} />}</Row>
          </dl>
          <Findings findings={prep.value.findings} />
          {prep.value.cost.balance < prep.value.cost.required && (
            <Notice tone="warn">
              Your wallet has {formatSol(prep.value.cost.balance)}; this claim needs about {formatSol(prep.value.cost.required)}. Add SOL first or the claim will fail.
            </Notice>
          )}
          <button type="button" class="button button-primary" onClick={() => void runClaim()}>
            Claim on Solana
          </button>
        </>
      )}
    </div>
  );
}

function phaseLabel(phase: string): string {
  return { simulating: "Checking…", signing: "Approve in your wallet", sending: "Sending…", confirming: "Confirming…", confirmed: "Done" }[phase] ?? phase;
}

function HistoryList() {
  if (history.value.length === 0) return null;
  return (
    <div class="history">
      <h3>Your recent returns</h3>
      <p class="muted small">Stored only in this browser. The Base transaction hash is all you need to recover a claim anywhere.</p>
      <ul>
        {history.value.map((entry) => (
          <li key={entry.txHash}>
            <button type="button" class="history-item" onClick={() => void track(entry.txHash)}>
              <span>{entry.amount ? `${entry.amount} ${entry.symbol ?? ""}` : "Return"}</span>
              <code>{entry.txHash.slice(0, 10)}…</code>
              <span class="muted">{timeAgo(entry.createdAt)}</span>
            </button>
            <button type="button" class="icon-button" aria-label="Remove from this list" onClick={() => removeFromHistory(entry.txHash as Hex)}>
              <Icon name="close" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
