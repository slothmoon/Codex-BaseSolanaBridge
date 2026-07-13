import { Keypair, PublicKey, Transaction, type Connection } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";

import {
  additionalRentLamports,
  encodeSolanaSignature,
  formatUnknownSubmissionMessage,
  getClaimProofAccountSpace,
  sendSolanaTransaction
} from "../claim";
import { type SolanaProvider } from "../shared";

function claimTransaction() {
  const payer = Keypair.generate();
  const transaction = new Transaction({
    feePayer: payer.publicKey,
    blockhash: Keypair.generate().publicKey.toBase58(),
    lastValidBlockHeight: 1234
  });
  return { payer, transaction };
}

describe("Solana wallet submission paths", () => {
  it("derives proof rent from the account path actually used", () => {
    expect(getClaimProofAccountSpace({ kind: "missing", lamports: 0 }, "0x010203")).toBe(36);
    expect(getClaimProofAccountSpace({ kind: "prefunded", lamports: 890_880 }, "0x010203")).toBe(36);
    expect(getClaimProofAccountSpace({ kind: "initialized", lamports: 1, executed: false }, "0x010203")).toBe(0);
    expect(additionalRentLamports(1_000_000n, 890_880n)).toBe(109_120n);
    expect(additionalRentLamports(1_000_000n, 1_000_000n)).toBe(0n);
  });

  it("keeps the RPC failure reason in unknown-submission guidance", () => {
    const message = formatUnknownSubmissionMessage("signature", new Error("RPC timed out"));
    expect(message).toMatch(/RPC timed out/);
    expect(message).toMatch(/Do not burn again/);
  });

  it("encodes locally known signatures in Solana base58 format", () => {
    const bytes = new Uint8Array(32);
    bytes[0] = 7;
    bytes[31] = 9;
    expect(encodeSolanaSignature(bytes)).toBe(new PublicKey(bytes).toBase58());
    expect(encodeSolanaSignature(new Uint8Array(32))).toBe("1".repeat(32));
  });

  it("signs locally, broadcasts once, and tracks the canonical signature", async () => {
    const { payer, transaction } = claimTransaction();
    const sendRawTransaction = vi.fn().mockResolvedValue("local-signature");
    const connection = { sendRawTransaction } as unknown as Connection;
    const provider: SolanaProvider = {
      connect: vi.fn(),
      signTransaction: vi.fn(async (value) => {
        value.partialSign(payer);
        return value;
      })
    };

    const result = await sendSolanaTransaction(provider, transaction, connection);
    expect(result).toMatchObject({
      status: "submitted",
      signature: encodeSolanaSignature(transaction.signature!),
      warning: expect.stringMatching(/unexpected signature/i)
    });
    expect(sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it("rejects a wallet-returned transaction with a different fee payer", async () => {
    const { transaction } = claimTransaction();
    const otherPayer = Keypair.generate();
    const signed = new Transaction({
      feePayer: otherPayer.publicKey,
      blockhash: transaction.recentBlockhash!,
      lastValidBlockHeight: transaction.lastValidBlockHeight!
    });
    signed.partialSign(otherPayer);
    const sendRawTransaction = vi.fn();
    const connection = {
      sendRawTransaction
    } as unknown as Connection;
    const provider: SolanaProvider = {
      connect: vi.fn(),
      signTransaction: vi.fn().mockResolvedValue(signed)
    };

    await expect(sendSolanaTransaction(provider, transaction, connection)).rejects.toThrow(/unexpected fee payer/i);
    expect(sendRawTransaction).not.toHaveBeenCalled();
  });

  it("accepts a wallet message change when the fee payer is unchanged", async () => {
    const { payer, transaction } = claimTransaction();
    const sendRawTransaction = vi.fn().mockImplementation(async (raw: Buffer | Uint8Array) => {
      return encodeSolanaSignature(Transaction.from(raw).signature!);
    });
    const connection = { sendRawTransaction } as unknown as Connection;
    const provider: SolanaProvider = {
      connect: vi.fn(),
      signTransaction: vi.fn(async (value) => {
        value.recentBlockhash = Keypair.generate().publicKey.toBase58();
        value.partialSign(payer);
        return value;
      })
    };

    await expect(sendSolanaTransaction(provider, transaction, connection)).resolves.toMatchObject({
      status: "submitted"
    });
    expect(sendRawTransaction).toHaveBeenCalledOnce();
  });

  it("supports wallets that sign and broadcast themselves", async () => {
    const { transaction } = claimTransaction();
    const connection = {} as Connection;
    const provider: SolanaProvider = {
      connect: vi.fn(),
      signAndSendTransaction: vi.fn().mockResolvedValue({ signature: "wallet-signature" })
    };

    await expect(sendSolanaTransaction(provider, transaction, connection)).resolves.toEqual({
      status: "submitted",
      signature: "wallet-signature"
    });
  });

  it("preserves the local signature when the broadcast outcome is unknown", async () => {
    const { payer, transaction } = claimTransaction();
    const connection = {
      sendRawTransaction: vi.fn().mockRejectedValue(new Error("RPC timed out"))
    } as unknown as Connection;
    const provider: SolanaProvider = {
      connect: vi.fn(),
      signTransaction: vi.fn(async (value) => {
        value.partialSign(payer);
        return value;
      })
    };

    const result = await sendSolanaTransaction(provider, transaction, connection);
    expect(result.signature).toBe(encodeSolanaSignature(transaction.signature!));
    expect(result.status).toBe("unknown");
    expect(connection.sendRawTransaction).toHaveBeenCalledTimes(1);
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
