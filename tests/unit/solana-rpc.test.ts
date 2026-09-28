// @vitest-environment node
// (Kit's Node build rejects happy-dom's AbortSignal; the browser build has no such check.)
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
