import { Buffer } from "buffer";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  buildRelayOnlyTransaction,
  createRelayInstruction,
  deriveAta,
  encodeProveMessage,
  getBlockheightConfirmationStrategy,
  getSolanaBridgeState,
  getTokenVaultPda,
  incomingMessageAccountSpace,
  parseBaseToSolanaTransfer,
  readIncomingMessageExecuted,
  readVaultBalance
} from "./solana";

const key = (byte: number): PublicKey => new PublicKey(new Uint8Array(32).fill(byte));

function accountInfo(data: Buffer, owner: PublicKey) {
  return { data, owner, executable: false, lamports: 1, rentEpoch: 0 };
}

describe("Base-to-Solana message encoding", () => {
  it("parses the official plain SPL-transfer layout", () => {
    const bytes = Buffer.alloc(98);
    bytes[0] = 1; // Message::Transfer
    bytes[1] = 1; // Transfer::Spl
    Buffer.alloc(20, 0x11).copy(bytes, 2);
    key(0x22).toBuffer().copy(bytes, 22);
    key(0x33).toBuffer().copy(bytes, 54);
    bytes.writeBigUInt64LE(123456n, 86);
    bytes.writeUInt32LE(0, 94); // no follow-up instructions

    const transfer = parseBaseToSolanaTransfer(`0x${bytes.toString("hex")}`);
    expect(transfer.remoteToken).toBe(`0x${"11".repeat(20)}`);
    expect(transfer.localMint.equals(key(0x22))).toBe(true);
    expect(transfer.toTokenAccount.equals(key(0x33))).toBe(true);
    expect(transfer.amount).toBe(123456n);
  });

  it("rejects messages containing follow-up Solana instructions", () => {
    const bytes = Buffer.alloc(98);
    bytes[0] = 1;
    bytes[1] = 1;
    bytes.writeUInt32LE(1, 94);
    expect(() => parseBaseToSolanaTransfer(`0x${bytes.toString("hex")}`)).toThrow(/extra Solana instructions/i);
  });

  it("matches the official prove-message discriminator and Borsh argument layout", () => {
    const encoded = encodeProveMessage({
      nonce: 5n,
      sender: `0x${"aa".repeat(20)}`,
      data: "0x0102",
      proof: [`0x${"bb".repeat(32)}`],
      messageHash: `0x${"cc".repeat(32)}`
    });
    const expected = [
      "ac424e889ebb2f73",
      "0500000000000000",
      "aa".repeat(20),
      "02000000",
      "0102",
      "01000000",
      "bb".repeat(32),
      "cc".repeat(32)
    ].join("");
    expect(encoded.toString("hex")).toBe(expected);
  });
});

describe("Solana instruction and account parity", () => {
  it("uses the official relay discriminator and remaining-account order", () => {
    const program = key(0x10);
    const incoming = key(0x20);
    const bridge = key(0x30);
    const mint = key(0x40);
    const destination = key(0x50);
    const remoteToken = `0x${"60".repeat(20)}` as const;
    const vault = getTokenVaultPda(program.toBase58(), mint, remoteToken);
    const instruction = createRelayInstruction(
      program,
      incoming,
      bridge,
      { remoteToken, localMint: mint, toTokenAccount: destination, amount: 1n },
      vault,
      TOKEN_2022_PROGRAM_ID
    );

    expect(instruction.data.toString("hex")).toBe("bb5ab68a33f8af62");
    expect(instruction.keys.map(({ pubkey }) => pubkey.toBase58())).toEqual([
      incoming,
      bridge,
      mint,
      vault,
      destination,
      TOKEN_2022_PROGRAM_ID
    ].map((value) => value.toBase58()));
    expect(instruction.keys.map(({ isWritable }) => isWritable)).toEqual([true, false, false, true, true, false]);
  });

  it("derives a stable Token-2022 ATA", () => {
    expect(deriveAta(key(0x71), key(0x72), TOKEN_2022_PROGRAM_ID).toBase58()).toBe(
      "FmbNooa1r9enXz9KTB1xH5veGYQrxMS7dSsm2XcmxQh8"
    );
  });
});

describe("Solana account decoding", () => {
  it("reads the current Bridge account offsets", async () => {
    const data = Buffer.alloc(200);
    data.writeBigUInt64LE(900n, 8);
    data[56] = 1;
    data.writeBigUInt64LE(300n, 169);
    const connection = {
      getAccountInfo: async () => accountInfo(data, key(0x80))
    } as unknown as Connection;

    const state = await getSolanaBridgeState(connection, key(0x80).toBase58());
    expect(state.baseBlockNumber).toBe(900n);
    expect(state.paused).toBe(true);
    expect(state.blockIntervalRequirement).toBe(300n);
  });

  it("decodes and validates the bridge vault base layout", async () => {
    const mint = key(0x91);
    const vault = key(0x92);
    const data = Buffer.alloc(165);
    mint.toBuffer().copy(data, 0);
    vault.toBuffer().copy(data, 32);
    data.writeBigUInt64LE(777n, 64);
    const connection = {
      getAccountInfo: async () => accountInfo(data, TOKEN_2022_PROGRAM_ID)
    } as unknown as Connection;

    await expect(readVaultBalance(connection, vault, mint, TOKEN_2022_PROGRAM_ID)).resolves.toBe(777n);
  });

  it("uses the serialized message boundary for execution and rent space", () => {
    const message = "0x010203" as const;
    const data = Buffer.alloc(8 + 20 + 3 + 1);
    data[data.length - 1] = 1;
    expect(readIncomingMessageExecuted(data, message)).toBe(true);
    expect(incomingMessageAccountSpace(message)).toBe(36);
  });
});

describe("Solana confirmation", () => {
  it("uses the transaction blockhash expiry strategy", () => {
    const transaction = new Transaction({
      feePayer: key(0xa1),
      blockhash: key(0xa2).toBase58(),
      lastValidBlockHeight: 1234
    });
    expect(getBlockheightConfirmationStrategy(transaction, "signature")).toEqual({
      signature: "signature",
      blockhash: key(0xa2).toBase58(),
      lastValidBlockHeight: 1234
    });
  });

  it("builds an ATA plus relay when a proof account already exists", async () => {
    const payer = key(0xb1);
    const mint = key(0xb2);
    const destination = deriveAta(payer, mint, TOKEN_PROGRAM_ID);
    const bytes = Buffer.alloc(98);
    bytes[0] = 1;
    bytes[1] = 1;
    Buffer.alloc(20, 0xb3).copy(bytes, 2);
    mint.toBuffer().copy(bytes, 22);
    destination.toBuffer().copy(bytes, 54);
    bytes.writeBigUInt64LE(5n, 86);
    bytes.writeUInt32LE(0, 94);

    const mintData = Buffer.alloc(82);
    mintData[44] = 6;
    const connection = {
      getAccountInfo: async () => accountInfo(mintData, TOKEN_PROGRAM_ID),
      getLatestBlockhash: async () => ({
        blockhash: key(0xb4).toBase58(),
        lastValidBlockHeight: 999
      })
    } as unknown as Connection;

    const result = await buildRelayOnlyTransaction({
      connection,
      programId: key(0xb5).toBase58(),
      payer,
      incomingMessage: key(0xb6),
      bridge: key(0xb7),
      data: `0x${bytes.toString("hex")}`
    });

    expect(result.transaction.instructions).toHaveLength(2);
    expect(result.transaction.instructions[0].programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).toBe(true);
    expect(result.transaction.instructions[1].data.toString("hex")).toBe("bb5ab68a33f8af62");
  });

  it("explains the ATA-only recovery scope for another destination", async () => {
    const payer = key(0xc1);
    const mint = key(0xc2);
    const destination = key(0xc3);
    const bytes = Buffer.alloc(98);
    bytes[0] = 1;
    bytes[1] = 1;
    Buffer.alloc(20, 0xc4).copy(bytes, 2);
    mint.toBuffer().copy(bytes, 22);
    destination.toBuffer().copy(bytes, 54);
    bytes.writeBigUInt64LE(5n, 86);
    bytes.writeUInt32LE(0, 94);

    const mintData = Buffer.alloc(82);
    const connection = {
      getAccountInfo: async () => accountInfo(mintData, TOKEN_PROGRAM_ID)
    } as unknown as Connection;

    await expect(buildRelayOnlyTransaction({
      connection,
      programId: key(0xc5).toBase58(),
      payer,
      incomingMessage: key(0xc6),
      bridge: key(0xc7),
      data: `0x${bytes.toString("hex")}`
    })).rejects.toThrow(/only claims transfers sent to the connected wallet's associated token account/i);
  });
});
