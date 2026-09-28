import { NETWORK, baseExplorerTx, solanaExplorerAccount } from "../config";
import {
  acknowledgedWarnings,
  activeRoute,
  amountInput,
  burn,
  burnState,
  evmAccount,
  evmOnBase,
  inspection,
  reviewRoute,
  route,
  solanaAddress,
  tokenInput
} from "../state/app";
import { ErrorNotice, Findings, Icon, Mono, Notice, Row, Spinner } from "./components";
import { formatAmount } from "./format";

export function ReturnCard() {
  const inspected = inspection.value;
  const info = inspected.status === "ready" ? inspected.value : null;
  const reviewed = activeRoute.value;
  const busyReview = route.value.status === "loading";
  const busyBurn = burnState.value.status === "loading";
  const blockers = reviewed?.findings.filter((finding) => finding.level === "block") ?? [];
  const warnings = reviewed?.findings.filter((finding) => finding.level === "warn") ?? [];
  const inspectionBlocked = info?.findings.some((finding) => finding.level === "block") ?? false;

  const missing: string[] = [];
  if (!evmAccount.value) missing.push("Base wallet");
  if (!solanaAddress.value) missing.push("Solana wallet");

  return (
    <section class="card" aria-labelledby="return-title">
      <header class="card-header">
        <span class="step-badge">1</span>
        <h2 id="return-title">Burn on Base</h2>
      </header>

      <div class="field">
        <label class="field-label" for="token-address">Wrapped token on Base</label>
        <div class="input-row">
          <input
            id="token-address"
            value={tokenInput.value}
            onInput={(event) => (tokenInput.value = event.currentTarget.value)}
            placeholder="0x… token address"
            spellcheck={false}
            autocomplete="off"
            inputMode="text"
            aria-describedby="token-help"
          />
          <button type="button" class="button button-ghost" onClick={() => (tokenInput.value = NETWORK.base.solWrapper)}>
            SOL
          </button>
        </div>
        <span id="token-help" class="field-help">Paste the Base address of the wrapped SPL token, or choose SOL.</span>
      </div>

      {inspected.status === "loading" && <Spinner label="Checking the token on Base and Solana…" />}
      {inspected.status === "error" && <ErrorNotice message={inspected.message} detail={inspected.detail} />}
      {info && (
        <div class="token-summary">
          <div class="token-title">
            <strong>{info.wrapper.symbol}</strong>
            <span class="muted">{info.wrapper.name}</span>
            <span class="pill pill-success"><Icon name="check" /> Bridge wrapper</span>
          </div>
          <dl class="rows">
            <Row label="Returns as">{info.kind === "sol" ? "Native SOL" : info.mint!.isToken2022 ? "SPL token (Token-2022)" : "SPL token"}</Row>
            {info.mint && <Row label="Solana mint"><Mono value={info.mint.address} href={solanaExplorerAccount(info.mint.address)} /></Row>}
            <Row label="Available to release">{formatAmount(info.vault.balance, info.wrapper.decimals)} {info.wrapper.symbol}</Row>
            {info.wrapper.balance !== null && <Row label="Your balance on Base">{formatAmount(info.wrapper.balance, info.wrapper.decimals)} {info.wrapper.symbol}</Row>}
          </dl>
          <Findings findings={info.findings} />
        </div>
      )}

      <div class="field">
        <label class="field-label" for="amount">Amount</label>
        <div class="input-row">
          <input
            id="amount"
            value={amountInput.value}
            onInput={(event) => (amountInput.value = event.currentTarget.value)}
            placeholder="0.0"
            inputMode="decimal"
            autocomplete="off"
            disabled={!info}
          />
          {info?.wrapper.balance ? (
            <button type="button" class="button button-ghost" onClick={() => (amountInput.value = formatAmount(info.wrapper.balance!, info.wrapper.decimals, info.wrapper.decimals).replace(/,/g, ""))}>
              Max
            </button>
          ) : null}
        </div>
      </div>

      {missing.length > 0 && info && <Notice tone="info">Connect your {missing.join(" and ")} to continue.</Notice>}
      {evmAccount.value && !evmOnBase.value && <Notice tone="warn">Switch your Base wallet to {NETWORK.base.chain.name}.</Notice>}

      {route.value.status === "error" && <ErrorNotice message={route.value.message} detail={route.value.detail} />}

      {reviewed && (
        <div class="review" aria-live="polite">
          <h3>Review</h3>
          <dl class="rows">
            <Row label="You burn on Base">{formatAmount(reviewed.amount, reviewed.inspection.wrapper.decimals, 9)} {reviewed.inspection.wrapper.symbol}</Row>
            <Row label="You receive on Solana">
              <strong>{formatAmount(reviewed.expectedReceived, reviewed.inspection.wrapper.decimals, 9)} {reviewed.inspection.kind === "sol" ? "SOL" : reviewed.inspection.wrapper.symbol}</strong>
              <span class="muted small"> · confirmed by a dry run of the release</span>
            </Row>
            <Row label="Recipient wallet"><Mono value={reviewed.recipientWallet} href={solanaExplorerAccount(reviewed.recipientWallet)} /></Row>
            {reviewed.inspection.kind === "spl" && (
              <Row label="Token account">
                <Mono value={reviewed.destination} href={reviewed.destinationExists ? solanaExplorerAccount(reviewed.destination) : undefined} />
                {!reviewed.destinationExists && <span class="muted"> (created when you claim)</span>}
              </Row>
            )}
            <Row label="Claimable">About 20–35 minutes after the burn, once Base finalizes it and an output root reaches Solana. Claiming is a separate Solana transaction you complete under Track &amp; claim.</Row>
          </dl>
          <Findings findings={reviewed.findings} />
          {blockers.length === 0 && warnings.length > 0 && (
            <label class="checkbox">
              <input type="checkbox" checked={acknowledgedWarnings.value} onChange={(event) => (acknowledgedWarnings.value = event.currentTarget.checked)} />
              <span>I understand the warnings above.</span>
            </label>
          )}
        </div>
      )}

      <div class="actions">
        {!reviewed ? (
          <button
            type="button"
            class="button button-primary"
            disabled={!info || inspectionBlocked || missing.length > 0 || !amountInput.value.trim() || busyReview || !evmOnBase.value}
            onClick={() => void reviewRoute()}
          >
            {busyReview ? <Spinner label="Checking route…" /> : "Review return"}
          </button>
        ) : (
          <button
            type="button"
            class="button button-primary"
            disabled={blockers.length > 0 || (warnings.length > 0 && !acknowledgedWarnings.value) || busyBurn}
            onClick={() => void burn()}
          >
            {busyBurn ? <Spinner label="Confirm in your Base wallet…" /> : <>Burn on Base <Icon name="arrow" /></>}
          </button>
        )}
        <p class="fine-print">Burning is irreversible. The destination is fixed at burn time and cannot be changed later.</p>
      </div>

      {burnState.value.status === "error" && <ErrorNotice message={burnState.value.message} detail={burnState.value.detail} />}
      {burnState.value.status === "ready" && (
        <Notice tone="success" title="Burn submitted">
          <Mono value={burnState.value.value} href={baseExplorerTx(burnState.value.value)} /> Tracking it in step 2.
        </Notice>
      )}
    </section>
  );
}
