import { afterEach, describe, expect, it } from "vitest";

import { state } from "./shared";
import { invalidateClaimStatus, rememberTx } from "./ui";

const hashA = `0x${"aa".repeat(32)}` as const;
const hashB = `0x${"bb".repeat(32)}` as const;
const originalDocument = globalThis.document;

function installDocument() {
  const claim = { disabled: false } as HTMLButtonElement;
  const statusBox = { innerHTML: "old status" } as HTMLDivElement;
  const txInput = { value: "" } as HTMLInputElement;
  const elements: Record<string, HTMLElement> = { claim, statusBox, txHash: txInput };
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { getElementById: (id: string) => elements[id] || null }
  });
  return { claim, statusBox, txInput };
}

afterEach(() => {
  state.currentStatus = null;
  state.currentTxHash = "";
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: originalDocument
  });
});

describe("claim status invalidation", () => {
  it("clears the previous status and disables claiming", () => {
    const { claim, statusBox } = installDocument();
    state.currentStatus = {
      status: "ready_to_claim",
      humanStatus: "Ready",
      txHash: hashA
    };

    invalidateClaimStatus();

    expect(state.currentStatus).toBeNull();
    expect(claim.disabled).toBe(true);
    expect(statusBox.innerHTML).toMatch(/Transaction changed/);
  });

  it("invalidates the old status when remembering a different hash", () => {
    const { claim, txInput } = installDocument();
    state.currentTxHash = hashA;
    state.currentStatus = {
      status: "ready_to_claim",
      humanStatus: "Ready",
      txHash: hashA
    };

    rememberTx(hashB);

    expect(state.currentStatus).toBeNull();
    expect(state.currentTxHash).toBe(hashB);
    expect(txInput.value).toBe(hashB);
    expect(claim.disabled).toBe(true);
  });
});
