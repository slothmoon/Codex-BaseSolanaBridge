import { Keypair, Transaction, type Connection } from "@solana/web3.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { applyConfirmationToClaimState, confirmSolanaTransaction, sendSolanaTransaction } from "./claim";
import { state, type SolanaProvider } from "./shared";

function claimTransaction() {
  const payer = Keypair.generate();
  const transaction = new Transaction({
    feePayer: payer.publicKey,
    blockhash: Keypair.generate().publicKey.toBase58(),
    lastValidBlockHeight: 1234
  });
  return { payer, transaction };
}

afterEach(() => {
  state.currentStatus = null;
});

describe("post-submission claim state", () => {
  it("marks a confirmed claim as completed", () => {
    state.currentStatus = {
      status: "ready_to_claim",
      humanStatus: "Ready",
      txHash: `0x${"11".repeat(32)}`
    };

    applyConfirmationToClaimState({ status: "confirmed" });

    expect(state.currentStatus?.status).toBe("claimed");
  });

  it("requires a fresh status check when confirmation is unknown", () => {
    state.currentStatus = {
      status: "proof_created",
      humanStatus: "Ready to relay",
      txHash: `0x${"22".repeat(32)}`
    };

    applyConfirmationToClaimState({ status: "unknown", error: new Error("timeout") });

    expect(state.currentStatus).toBeNull();
  });

  it("keeps a failed claim retryable", () => {
    state.currentStatus = {
      status: "ready_to_claim",
      humanStatus: "Ready",
      txHash: `0x${"33".repeat(32)}`
    };

    applyConfirmationToClaimState({ status: "failed", reason: "failure" });

    expect(state.currentStatus?.status).toBe("ready_to_claim");
  });
});

describe("Solana confirmation outcomes", () => {
  it("reports a successful confirmation", async () => {
    const { transaction } = claimTransaction();
    const connection = {
      confirmTransaction: vi.fn().mockResolvedValue({ value: { err: null } })
    } as unknown as Connection;

    await expect(confirmSolanaTransaction(connection, transaction, "signature")).resolves.toEqual({
      status: "confirmed"
    });
  });

  it("reports an on-chain failure with transaction logs", async () => {
    const { transaction } = claimTransaction();
    const reason = { InstructionError: [1, { Custom: 6000 }] };
    const connection = {
      confirmTransaction: vi.fn().mockResolvedValue({ value: { err: reason } }),
      getTransaction: vi.fn().mockResolvedValue({ meta: { logMessages: ["Program log: failed"] } })
    } as unknown as Connection;

    await expect(confirmSolanaTransaction(connection, transaction, "signature")).resolves.toEqual({
      status: "failed",
      reason,
      logs: ["Program log: failed"]
    });
  });

  it("keeps the confirmed failure when logs are unavailable", async () => {
    const { transaction } = claimTransaction();
    const reason = { InstructionError: [0, "InvalidArgument"] };
    const connection = {
      confirmTransaction: vi.fn().mockResolvedValue({ value: { err: reason } }),
      getTransaction: vi.fn().mockRejectedValue(new Error("RPC unavailable"))
    } as unknown as Connection;

    await expect(confirmSolanaTransaction(connection, transaction, "signature")).resolves.toEqual({
      status: "failed",
      reason,
      logs: undefined
    });
  });

  it("reports an unknown outcome when confirmation cannot be read", async () => {
    const { transaction } = claimTransaction();
    const error = new Error("confirmation timed out");
    const connection = {
      confirmTransaction: vi.fn().mockRejectedValue(error)
    } as unknown as Connection;

    await expect(confirmSolanaTransaction(connection, transaction, "signature")).resolves.toEqual({
      status: "unknown",
      error
    });
  });
});

describe("Solana wallet submission paths", () => {
  it("signs locally, broadcasts once, and preserves an unknown confirmation", async () => {
    const { payer, transaction } = claimTransaction();
    const sendRawTransaction = vi.fn().mockResolvedValue("local-signature");
    const connection = {
      sendRawTransaction,
      confirmTransaction: vi.fn().mockRejectedValue(new Error("confirmation timed out"))
    } as unknown as Connection;
    const provider: SolanaProvider = {
      connect: vi.fn(),
      signTransaction: vi.fn(async (value) => {
        value.partialSign(payer);
        return value;
      })
    };

    const result = await sendSolanaTransaction(provider, transaction, connection);
    expect(result.signature).toBe("local-signature");
    expect(result.confirmation.status).toBe("unknown");
    expect(sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it("supports wallets that sign and broadcast themselves", async () => {
    const { transaction } = claimTransaction();
    const connection = {
      confirmTransaction: vi.fn().mockResolvedValue({ value: { err: null } })
    } as unknown as Connection;
    const provider: SolanaProvider = {
      connect: vi.fn(),
      signAndSendTransaction: vi.fn().mockResolvedValue({ signature: "wallet-signature" })
    };

    await expect(sendSolanaTransaction(provider, transaction, connection)).resolves.toEqual({
      signature: "wallet-signature",
      confirmation: { status: "confirmed" }
    });
  });

  it("rejects an unsigned transaction before broadcasting", async () => {
    const { transaction } = claimTransaction();
    const sendRawTransaction = vi.fn();
    const connection = { sendRawTransaction } as unknown as Connection;
    const provider: SolanaProvider = {
      connect: vi.fn(),
      signTransaction: vi.fn().mockResolvedValue(transaction)
    };

    await expect(sendSolanaTransaction(provider, transaction, connection)).rejects.toThrow(/did not sign/i);
    expect(sendRawTransaction).not.toHaveBeenCalled();
  });
});
