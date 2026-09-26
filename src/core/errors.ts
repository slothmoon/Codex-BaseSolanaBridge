import { NETWORK } from "../config";
import { BRIDGE_PROGRAM_ERRORS } from "../protocol/program-errors";

/** An error whose message is already written for the person using the app. */
export class UserFacingError extends Error {
  constructor(message: string, readonly detail?: string) {
    super(message);
    this.name = "UserFacingError";
  }
}

const RATE_LIMIT = /rate.?limit|too many requests|\b429\b|exceeded.*limit|capacity/i;
const REJECTED = /user rejected|rejected the request|denied|cancel+ed|declined/i;

export function describeError(error: unknown): { message: string; detail?: string } {
  if (error instanceof UserFacingError) return { message: error.message, detail: error.detail };
  const raw = collectMessages(error);
  const code = providerCode(error);
  if (code === 4001 || REJECTED.test(raw)) return { message: "You rejected the request in your wallet. Nothing was sent." };
  if (RATE_LIMIT.test(raw)) {
    return { message: "A public RPC endpoint is rate limiting requests. Wait a few seconds and try again.", detail: raw };
  }
  return { message: firstLine(raw) || "Something went wrong.", detail: raw };
}

function firstLine(value: string): string {
  return value.split("\n")[0].trim();
}

function collectMessages(error: unknown): string {
  const parts: string[] = [];
  for (let current = error as { message?: unknown; shortMessage?: unknown; cause?: unknown } | undefined, depth = 0; current && depth < 6; current = current.cause as never, depth++) {
    const text = typeof current.shortMessage === "string" ? current.shortMessage : typeof current.message === "string" ? current.message : typeof current === "string" ? current : "";
    if (text && !parts.includes(text)) parts.push(text);
    if (typeof current !== "object") break;
  }
  return parts.join("\n") || String(error);
}

function providerCode(error: unknown): number | undefined {
  for (let current = error as { code?: unknown; cause?: unknown } | undefined, depth = 0; current && typeof current === "object" && depth < 6; current = current.cause as never, depth++) {
    const code = Number(current.code);
    if (Number.isFinite(code) && current.code !== undefined) return code;
  }
  return undefined;
}

/**
 * Turns a Solana `TransactionError` (from simulation or a failed signature) into a readable reason,
 * naming the bridge program error when there is one.
 */
export function explainTransactionError(error: unknown, programs: readonly string[], logs?: readonly string[] | null): string {
  const logHint = explainLogs(logs);
  if (error && typeof error === "object" && "InstructionError" in error) {
    const [rawIndex, inner] = (error as { InstructionError: [number | bigint, unknown] }).InstructionError;
    const index = Number(rawIndex);
    if (inner && typeof inner === "object" && "Custom" in inner) {
      const code = Number((inner as { Custom: number | bigint }).Custom);
      if (programs[index] === NETWORK.solana.bridgeProgram && BRIDGE_PROGRAM_ERRORS[code]) {
        const [name, message] = BRIDGE_PROGRAM_ERRORS[code];
        return `${friendlyBridgeError(name) ?? message} (bridge error ${name})`;
      }
      return logHint ?? `Instruction ${index + 1} failed with error code ${code}.`;
    }
    return logHint ?? `Instruction ${index + 1} failed: ${stringify(inner)}.`;
  }
  if (error === "InsufficientFundsForFee" || error === "InsufficientFundsForRent" || (error && typeof error === "object" && "InsufficientFundsForRent" in error)) {
    return "Your Solana wallet does not have enough SOL for fees and account rent. Add a little SOL and try again.";
  }
  if (error === "BlockhashNotFound") return "The transaction expired before it landed. Try again.";
  if (error === "AlreadyProcessed") return "This transaction was already processed.";
  return logHint ?? `Solana rejected the transaction: ${stringify(error)}.`;
}

function friendlyBridgeError(name: string): string | undefined {
  switch (name) {
    case "BridgePaused":
      return "The Solana side of the bridge is paused. Your funds are safe; try again once it is unpaused.";
    case "AlreadyExecuted":
      return "This message has already been claimed.";
    case "InvalidProof":
    case "InvalidMessageHash":
      return "The proof did not match the output root on Solana. Refresh the status and try again.";
    default:
      return undefined;
  }
}

function explainLogs(logs?: readonly string[] | null): string | undefined {
  if (!logs) return undefined;
  const insufficient = logs.find((line) => /insufficient lamports/i.test(line));
  if (insufficient) return "Your Solana wallet does not have enough SOL for fees and account rent. Add a little SOL and try again.";
  if (logs.some((line) => /already in use/i.test(line))) return "The proof account already exists. Refresh the status; the message may already be proven or claimed.";
  return undefined;
}

function stringify(value: unknown): string {
  return JSON.stringify(value, (_, inner) => (typeof inner === "bigint" ? inner.toString() : inner));
}
