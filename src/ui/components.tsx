import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";

import type { Finding } from "../core/route";
import { shortAddress } from "./format";

export function Icon({ name }: { name: "copy" | "check" | "external" | "arrow" | "alert" | "info" | "close" | "spinner" | "wallet" }) {
  const paths: Record<string, ComponentChildren> = {
    copy: <><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 0 1 2-2h8" /></>,
    check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
    external: <><path d="M14 4h6v6" /><path d="M20 4l-9 9" /><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" /></>,
    arrow: <><path d="M4 12h15" /><path d="M13 6l6 6-6 6" /></>,
    alert: <><path d="M12 3l9.5 17h-19z" /><path d="M12 10v4" /><path d="M12 17.5v.01" /></>,
    info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5" /><path d="M12 7.5v.01" /></>,
    close: <><path d="M6 6l12 12" /><path d="M18 6L6 18" /></>,
    spinner: <path d="M12 3a9 9 0 1 0 9 9" />,
    wallet: <><rect x="3" y="6" width="18" height="13" rx="2" /><path d="M16 12.5h2" /><path d="M3 9h15a3 3 0 0 0 3-3" /></>
  };
  return (
    <svg class={`icon icon-${name}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span class="spinner" role="status">
      <Icon name="spinner" />
      {label && <span>{label}</span>}
    </span>
  );
}

export function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1400);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      class="icon-button"
      aria-label={copied ? "Copied" : `Copy ${value}`}
      title={copied ? "Copied" : "Copy"}
      onClick={() => {
        navigator.clipboard?.writeText(value).then(() => setCopied(true), () => undefined);
      }}
    >
      <Icon name={copied ? "check" : "copy"} />
    </button>
  );
}

/** A shortened address or hash with copy and optional explorer link. */
export function Mono({ value, href }: { value: string; href?: string }) {
  return (
    <span class="mono-value">
      <code title={value}>{shortAddress(value, 6, 6)}</code>
      <CopyButton value={value} />
      {href && (
        <a class="icon-button" href={href} target="_blank" rel="noreferrer noopener" aria-label="Open in explorer" title="Open in explorer">
          <Icon name="external" />
        </a>
      )}
    </span>
  );
}

export function Notice({ tone, title, children }: { tone: "info" | "warn" | "danger" | "success"; title?: string; children?: ComponentChildren }) {
  return (
    <div class={`notice notice-${tone}`} role={tone === "danger" ? "alert" : "note"}>
      <Icon name={tone === "info" || tone === "success" ? "info" : "alert"} />
      <div>
        {title && <strong>{title}</strong>}
        {children && <div class="notice-body">{children}</div>}
      </div>
    </div>
  );
}

export function Findings({ findings }: { findings: Finding[] }) {
  if (findings.length === 0) return null;
  const ordered = [...findings].sort((a, b) => (a.level === b.level ? 0 : a.level === "block" ? -1 : 1));
  return (
    <div class="findings">
      {ordered.map((finding) => (
        <Notice key={finding.code} tone={finding.level === "block" ? "danger" : "warn"}>{finding.message}</Notice>
      ))}
    </div>
  );
}

export function ErrorNotice({ message, detail }: { message: string; detail?: string }) {
  return (
    <Notice tone="danger">
      {message}
      {detail && detail !== message && (
        <details class="error-detail">
          <summary>Technical details</summary>
          <pre>{detail}</pre>
        </details>
      )}
    </Notice>
  );
}

export function Row({ label, children }: { label: string; children: ComponentChildren }) {
  return (
    <div class="row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export function Dialog({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ComponentChildren }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal?.();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog ref={ref} class="dialog" onClose={onClose} onCancel={onClose} aria-label={title}>
      <header class="dialog-header">
        <h2>{title}</h2>
        <button type="button" class="icon-button" aria-label="Close" onClick={onClose}>
          <Icon name="close" />
        </button>
      </header>
      {children}
    </dialog>
  );
}
