import { describe, expect, it } from "vitest";

import { classifyAvailableMessage } from "../bridge-status";

const txHash = `0x${"11".repeat(32)}` as const;

function classify(input: {
  incomingExecuted?: boolean | null;
  latestRootBlock?: bigint;
  baseBlockNumber?: bigint;
  paused?: boolean;
}) {
  const baseBlockNumber = input.baseBlockNumber ?? 700n;
  const latestRootBlock = input.latestRootBlock ?? 900n;
  return classifyAvailableMessage({
    common: {
      txHash,
      baseBlockNumber,
      solanaBaseBlockNumber: latestRootBlock,
      bridgePaused: input.paused ?? false
    },
    incomingExecuted: input.incomingExecuted ?? null,
    latestRootBlock,
    blockIntervalRequirement: 300n
  });
}

describe("available bridge message classification", () => {
  it("reports an executed incoming message as claimed even while paused", () => {
    const status = classify({ incomingExecuted: true, paused: true });
    expect(status.status).toBe("claimed");
    expect(status.bridgePaused).toBe(true);
  });

  it("reports an unexecuted proof account as relayable", () => {
    expect(classify({ incomingExecuted: false }).status).toBe("proof_created");
  });

  it("keeps proof status visible but explains that a paused bridge cannot relay", () => {
    const status = classify({ incomingExecuted: false, paused: true });
    expect(status.status).toBe("proof_created");
    expect(status.humanStatus).toMatch(/bridge is paused/i);
  });

  it("reports a covered Base block as ready", () => {
    expect(classify({ latestRootBlock: 900n, baseBlockNumber: 700n }).status).toBe("ready_to_claim");
  });

  it("keeps ready status visible but explains that a paused bridge cannot claim", () => {
    const status = classify({ latestRootBlock: 900n, baseBlockNumber: 700n, paused: true });
    expect(status.status).toBe("ready_to_claim");
    expect(status.humanStatus).toMatch(/bridge is paused/i);
  });

  it("reports output-root progress while waiting, including during a pause", () => {
    const status = classify({ latestRootBlock: 600n, baseBlockNumber: 700n, paused: true });
    expect(status.status).toBe("waiting_for_root");
    expect(status.nextEligibleRootBlock).toBe(900n);
    expect(status.rootBlocksBehind).toBe(300n);
    expect(status.humanStatus).toMatch(/status checks remain available/i);
  });
});
