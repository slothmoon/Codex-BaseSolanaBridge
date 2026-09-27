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
// Only explicit user refusals. Generic "cancelled"/"denied" errors (timeouts, RPC failures) must not
// count, because treating an ambiguous send failure as a rejection would allow a double burn.
const REJECTED = /user rejected|user denied|rejected (the|this) request|user cancel+ed|request rejected by user/i;

/** An explicit "no" from the user in their wallet (EIP-1193 code 4001 or equivalent wording). */
export function isWalletRejection(error: unknown): boolean {
  if (error instanceof UserFacingError) return false;
  return providerCode(error) === 4001 || REJECTED.test(collectMessages(error));
}

export function describeError(error: unknown): { message: string; detail?: string } {
  if (error instanceof UserFacingError) return { message: error.message, detail: error.detail };
  const raw = collectMessages(error);
  if (isWalletRejection(error)) return { message: "You rejected the request in your wallet. Nothing was sent." };
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
      return "The proof did not match the output root on Solana. Click Track to refresh the status, then try again.";
    default:
      return undefined;
  }
}

/**
 * Anchor logs name the error (`Error Code: AlreadyExecuted. Error Number: 12501.`), which works on
 * every failure path, including RPC preflight rejections where the raw error is not returned.
 */
export function explainLogs(logs?: readonly string[] | null): string | undefined {
  if (!logs) return undefined;
  for (const line of logs) {
    const match = /Error Code: (\w+)\. Error Number: (\d+)/.exec(line);
    const known = match ? BRIDGE_PROGRAM_ERRORS[Number(match[2])] : undefined;
    if (known && known[0] === match![1]) return `${friendlyBridgeError(known[0]) ?? known[1]} (bridge error ${known[0]})`;
  }
  const insufficient = logs.find((line) => /insufficient lamports/i.test(line));
  if (insufficient) return "Your Solana wallet does not have enough SOL for fees and account rent. Add a little SOL and try again.";
  if (logs.some((line) => /already in use/i.test(line))) return "The proof account already exists. Click Track to refresh the status; the message may already be proven or claimed.";
  return undefined;
}

function stringify(value: unknown): string {
  return JSON.stringify(value, (_, inner) => (typeof inner === "bigint" ? inner.toString() : inner));
}
