import { formatUnits } from "viem";

export function shortAddress(value: string, head = 4, tail = 4): string {
  return value.length > head + tail + 3 ? `${value.slice(0, head + (value.startsWith("0x") ? 2 : 0))}…${value.slice(-tail)}` : value;
}

/** Human amount with thousands separators and at most `maxFraction` fraction digits (never rounds up). */
export function formatAmount(value: bigint, decimals: number, maxFraction = 6): string {
  const [whole, fraction = ""] = formatUnits(value, decimals).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const trimmed = fraction.slice(0, maxFraction).replace(/0+$/, "");
  if (!trimmed && fraction && /[1-9]/.test(fraction)) return `${grouped}.${fraction.slice(0, decimals).replace(/0+$/, "")}`;
  return trimmed ? `${grouped}.${trimmed}` : grouped;
}

export function formatSol(lamports: bigint): string {
  return `${formatAmount(lamports, 9, 6)} SOL`;
}

export function formatDuration(seconds: number): string {
  if (seconds <= 45) return "under a minute";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `about ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `about ${hours} h ${rest} min` : `about ${hours} h`;
}

export function timeAgo(timestamp: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return new Date(timestamp).toLocaleDateString();
}
