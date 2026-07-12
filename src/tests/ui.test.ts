import { afterEach, describe, expect, it } from "vitest";

import { state } from "../shared";
import { beginBusyAction, invalidateBurnValidation, invalidateClaimStatus, readTxHash, rememberTx, syncBaseActionButtons } from "../ui";

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
  state.validatedBurnKey = "";
  state.actionInFlight = false;
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

  it("does not silently reuse a hidden saved hash when the input is empty", () => {
    installDocument();
    state.currentTxHash = hashA;

    expect(() => readTxHash()).toThrow(/paste a valid/i);
  });
});

describe("action locking", () => {
  it("disables and restores inputs and buttons while an action is running", () => {
    const activeButton = {
      disabled: false,
      textContent: "Check status",
      classList: { add() {}, remove() {} }
    } as unknown as HTMLButtonElement;
    const input = { disabled: false } as HTMLInputElement;
    const shell = {
      setAttribute() {},
      removeAttribute() {}
    } as unknown as HTMLElement;

    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        querySelector: () => shell,
        querySelectorAll: (selector: string) => selector === "button" ? [activeButton] : [input],
        getElementById: (id: string) => id === "checkStatus" ? activeButton : null
      }
    });

    const end = beginBusyAction({ buttonId: "checkStatus", label: "Checking..." });
    expect(activeButton.disabled).toBe(true);
    expect(input.disabled).toBe(true);

    end();
    expect(activeButton.disabled).toBe(false);
    expect(input.disabled).toBe(false);
    expect(activeButton.textContent).toBe("Check status");
  });

  it("keeps claim disabled when status becomes ready during an active action", () => {
    const claim = { disabled: false } as HTMLButtonElement;
    const checkStatus = { disabled: false } as HTMLButtonElement;
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        querySelectorAll: () => [claim, checkStatus],
        getElementById: (id: string) => id === "claim" ? claim : id === "checkStatus" ? checkStatus : null
      }
    });
    state.currentStatus = {
      status: "ready_to_claim",
      humanStatus: "Ready",
      txHash: hashA
    };
    state.actionInFlight = true;

    syncBaseActionButtons();

    expect(claim.disabled).toBe(true);
    expect(checkStatus.disabled).toBe(true);
  });
});

describe("burn validation consumption", () => {
  it("hides and disables burn until the route is validated again", () => {
    const burnButton = { disabled: false, hidden: false } as HTMLButtonElement;
    const deriveButton = { disabled: true, hidden: true } as HTMLButtonElement;
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        getElementById: (id: string) => id === "burnButton" ? burnButton : id === "deriveDetails" ? deriveButton : null
      }
    });
    state.validatedBurnKey = "validated";

    invalidateBurnValidation();

    expect(state.validatedBurnKey).toBe("");
    expect(burnButton.disabled).toBe(true);
    expect(burnButton.hidden).toBe(true);
    expect(deriveButton.hidden).toBe(false);
  });
});
