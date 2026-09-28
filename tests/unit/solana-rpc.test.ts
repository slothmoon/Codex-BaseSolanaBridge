// @vitest-environment node
// (Kit's Node build rejects happy-dom's AbortSignal; the browser build has no such check.)
import { isSolanaError, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE, SOLANA_ERROR__TRANSACTION_ERROR__ALREADY_PROCESSED } from "@solana/kit";
import { afterEach, expect, it, vi } from "vitest";

import { getSolanaRpc } from "../../src/chain/solana";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("fails a Solana request the RPC never answers instead of hanging forever", async () => {
  // The time limit runs out right away instead of after 30 s.
  vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("timed out")), 0);
    return controller.signal;
  });
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined))); // never answers
  await expect(getSolanaRpc().getBlockHeight().send()).rejects.toThrow("timed out");
}, 2_000);

it("reports publicnode's preflight rejections, which leave out the `data` kit expects", async () => {
  // publicnode's real answer to a rejected send (the official RPC also includes `data: { err, logs }`).
  const answer = (message: string) => vi.fn(async () => new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32002, message }, id: 1 })));
  const send = () => getSolanaRpc().sendTransaction("AQ==" as never, { encoding: "base64" }).send();

  vi.stubGlobal("fetch", answer("Transaction simulation failed: Attempt to debit an account but found no record of a prior credit."));
  const rejected = await send().catch((error: unknown) => error);
  expect(isSolanaError(rejected, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE)).toBe(true);
  expect((rejected as Error).cause).toMatchObject({ message: expect.stringMatching(/Attempt to debit an account/) });

  vi.stubGlobal("fetch", answer("Transaction simulation failed: This transaction has already been processed"));
  const processed = await send().catch((error: unknown) => error);
  expect(isSolanaError((processed as Error).cause, SOLANA_ERROR__TRANSACTION_ERROR__ALREADY_PROCESSED)).toBe(true);
});
