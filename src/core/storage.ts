import type { Address } from "@solana/kit";
import { isHash, type Hex } from "viem";

import { NETWORK } from "../config";

// Browser storage is a convenience only: every read is validated and every failure is ignored, so the
// app works the same in private windows or when storage is blocked. Nothing here is needed to recover
// funds — the Base transaction hash is always enough.

const PREFIX = `base-solana-return:v2:${NETWORK.id}`;

function read<T>(key: string, fallback: T): T {
  try {
    const raw = globalThis.localStorage?.getItem(`${PREFIX}:${key}`);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    globalThis.localStorage?.setItem(`${PREFIX}:${key}`, JSON.stringify(value));
  } catch {
    // Storage unavailable; ignore.
  }
}

export type HistoryEntry = {
  txHash: Hex;
  createdAt: number;
  symbol?: string;
  amount?: string;
};

const HISTORY_LIMIT = 25;

export function loadHistory(): HistoryEntry[] {
  const entries = read<unknown>("history", []);
  if (!Array.isArray(entries)) return [];
  return entries.filter((entry): entry is HistoryEntry => Boolean(entry) && isHash((entry as HistoryEntry).txHash)).slice(0, HISTORY_LIMIT);
}

export function rememberBurn(entry: HistoryEntry): HistoryEntry[] {
  const next = [entry, ...loadHistory().filter((item) => item.txHash.toLowerCase() !== entry.txHash.toLowerCase())].slice(0, HISTORY_LIMIT);
  write("history", next);
  return next;
}

export function forgetBurn(txHash: Hex): HistoryEntry[] {
  const next = loadHistory().filter((item) => item.txHash.toLowerCase() !== txHash.toLowerCase());
  write("history", next);
  return next;
}

/** A prove buffer is tied to the output root its proof was generated against. */
export type BufferRecord = { address: Address; rootBlock: string; payer: Address };

export function loadBufferRecord(messageHash: Hex): BufferRecord | null {
  const records = read<Record<string, BufferRecord>>("buffers", {});
  return records[messageHash.toLowerCase()] ?? null;
}

export function saveBufferRecord(messageHash: Hex, record: BufferRecord): void {
  const records = read<Record<string, BufferRecord>>("buffers", {});
  records[messageHash.toLowerCase()] = record;
  write("buffers", records);
}

export function clearBufferRecord(messageHash: Hex): void {
  const records = read<Record<string, BufferRecord>>("buffers", {});
  delete records[messageHash.toLowerCase()];
  write("buffers", records);
}

export function loadPreference(key: string): string | null {
  return read<string | null>(`pref:${key}`, null);
}

export function savePreference(key: string, value: string | null): void {
  write(`pref:${key}`, value);
}
