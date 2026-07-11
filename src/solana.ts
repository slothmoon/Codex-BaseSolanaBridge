import { Buffer } from "buffer";
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction
} from "@solana/web3.js";
import { hexToBytes, type Hex } from "viem";

export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

const OUTPUT_ROOT_SEED = Buffer.from("output_root");
const INCOMING_MESSAGE_SEED = Buffer.from("incoming_message");
const BRIDGE_SEED = Buffer.from("bridge");
const TOKEN_VAULT_SEED = Buffer.from("token_vault");
const BRIDGE_PROTOCOL_CONFIG_OFFSET = 8 + 8 + 8 + 32 + 1 + 56 + 56;
const PROVE_MESSAGE_DISCRIMINATOR = Buffer.from([172, 66, 78, 136, 158, 187, 47, 115]);
const RELAY_MESSAGE_DISCRIMINATOR = Buffer.from([187, 90, 182, 138, 51, 248, 175, 98]);
const CREATE_IDEMPOTENT_ATA_DISCRIMINATOR = Buffer.from([1]);
const MINT_SIZE = 82;

export type BridgeState = {
  bridge: PublicKey;
  baseBlockNumber: bigint;
  blockIntervalRequirement: bigint;
  paused: boolean;
};

export type ParsedTransfer = {
  remoteToken: `0x${string}`;
  localMint: PublicKey;
  toTokenAccount: PublicKey;
  amount: bigint;
};

export type MintInfo = {
  owner: PublicKey;
  decimals: number;
  tokenProgramLabel: "Standard SPL Token" | "Token-2022";
};

export function pubkeyToBytes32(value: PublicKey | string): `0x${string}` {
  const publicKey = typeof value === "string" ? new PublicKey(value) : value;
  return `0x${Buffer.from(publicKey.toBytes()).toString("hex")}`;
}

export function bytes32ToPubkey(value: Hex): PublicKey {
  return new PublicKey(Buffer.from(hexToBytes(value)));
}

export function deriveAta(owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBytes(), tokenProgram.toBytes(), mint.toBytes()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  )[0];
}

export function getBridgePda(programId: string): PublicKey {
  return PublicKey.findProgramAddressSync([BRIDGE_SEED], new PublicKey(programId))[0];
}

export function getOutputRootPda(programId: string, baseBlockNumber: bigint): PublicKey {
  return PublicKey.findProgramAddressSync(
    [OUTPUT_ROOT_SEED, u64Le(baseBlockNumber)],
    new PublicKey(programId)
  )[0];
}

export function getIncomingMessagePda(programId: string, messageHash: Hex): PublicKey {
  return PublicKey.findProgramAddressSync(
    [INCOMING_MESSAGE_SEED, Buffer.from(hexToBytes(messageHash))],
    new PublicKey(programId)
  )[0];
}

export function getTokenVaultPda(programId: string, mint: PublicKey, remoteToken: `0x${string}`): PublicKey {
  return PublicKey.findProgramAddressSync(
    [TOKEN_VAULT_SEED, mint.toBytes(), Buffer.from(hexToBytes(remoteToken))],
    new PublicKey(programId)
  )[0];
}

export async function getSolanaBridgeState(connection: Connection, programId: string): Promise<BridgeState> {
  const bridge = getBridgePda(programId);
  const account = await connection.getAccountInfo(bridge, "confirmed");
  if (!account) throw new Error("The Solana bridge state account was not found.");
  if (account.data.length <= BRIDGE_PROTOCOL_CONFIG_OFFSET + 8) {
    throw new Error("The Solana bridge state account has an unexpected layout.");
  }

  const data = Buffer.from(account.data);
  return {
    bridge,
    baseBlockNumber: data.readBigUInt64LE(8),
    paused: data[8 + 8 + 8 + 32] === 1,
    blockIntervalRequirement: data.readBigUInt64LE(BRIDGE_PROTOCOL_CONFIG_OFFSET)
  };
}

export async function readMintInfo(connection: Connection, mint: PublicKey): Promise<MintInfo> {
  const account = await connection.getAccountInfo(mint, "confirmed");
  if (!account) throw new Error(`Solana mint ${mint.toBase58()} was not found.`);
  if (account.data.length < MINT_SIZE) throw new Error("The remote Solana account is not a valid SPL mint.");

  let tokenProgramLabel: MintInfo["tokenProgramLabel"];
  if (account.owner.equals(TOKEN_PROGRAM_ID)) tokenProgramLabel = "Standard SPL Token";
  else if (account.owner.equals(TOKEN_2022_PROGRAM_ID)) tokenProgramLabel = "Token-2022";
  else throw new Error(`Unsupported Solana token program: ${account.owner.toBase58()}. No transaction was submitted.`);

  return {
    owner: account.owner,
    decimals: account.data[44],
    tokenProgramLabel
  };
}

export async function readVaultBalance(
  connection: Connection,
  vault: PublicKey,
  mint: PublicKey,
  tokenProgram: PublicKey
): Promise<bigint> {
  const account = await connection.getAccountInfo(vault, "confirmed");
  if (!account) throw new Error("The bridge vault for this SPL token does not exist. This token cannot be returned through this route.");
  if (!account.owner.equals(tokenProgram)) throw new Error("The bridge vault is owned by an unexpected token program.");
  if (account.data.length < 165) throw new Error("The bridge vault has an unexpected token-account layout.");

  const data = Buffer.from(account.data);
  const vaultMint = new PublicKey(data.subarray(0, 32));
  const vaultAuthority = new PublicKey(data.subarray(32, 64));
  if (!vaultMint.equals(mint)) throw new Error("The bridge vault mint does not match the wrapper's remote mint.");
  if (!vaultAuthority.equals(vault)) throw new Error("The bridge vault authority does not match the expected vault PDA.");
  return data.readBigUInt64LE(64);
}

export function parseBaseToSolanaTransfer(messageDataHex: Hex): ParsedTransfer {
  const bytes = Buffer.from(hexToBytes(messageDataHex));
  const transferLength = 94;
  const emptyInstructionsLength = 4;
  if (bytes.length < transferLength + emptyInstructionsLength) throw new Error("The Base bridge message is shorter than expected.");
  if (bytes[0] !== 1) throw new Error("This Base message is not a token transfer.");
  if (bytes[1] !== 1) throw new Error("This page only supports returning bridged SPL tokens.");
  if (bytes.readUInt32LE(transferLength) !== 0 || bytes.length !== transferLength + emptyInstructionsLength) {
    throw new Error("This bridge transaction includes extra Solana instructions. This simple interface only supports plain SPL token returns.");
  }

  return {
    remoteToken: `0x${bytes.subarray(2, 22).toString("hex")}`,
    localMint: new PublicKey(bytes.subarray(22, 54)),
    toTokenAccount: new PublicKey(bytes.subarray(54, 86)),
    amount: bytes.readBigUInt64LE(86)
  };
}

export async function buildClaimTransaction(input: {
  connection: Connection;
  programId: string;
  payer: PublicKey;
  outputRoot: PublicKey;
  incomingMessage: PublicKey;
  bridge: PublicKey;
  nonce: bigint;
  sender: Hex;
  data: Hex;
  proof: readonly Hex[];
  messageHash: Hex;
}): Promise<{ transaction: Transaction; transfer: ParsedTransfer }> {
  const transfer = parseBaseToSolanaTransfer(input.data);
  const mintInfo = await readMintInfo(input.connection, transfer.localMint);
  assertRecipientWallet(input.payer, transfer, mintInfo.owner);
  const tokenVault = getTokenVaultPda(input.programId, transfer.localMint, transfer.remoteToken);
  const program = new PublicKey(input.programId);

  const proveIx = new TransactionInstruction({
    programId: program,
    keys: [
      { pubkey: input.payer, isSigner: true, isWritable: true },
      { pubkey: input.outputRoot, isSigner: false, isWritable: false },
      { pubkey: input.incomingMessage, isSigner: false, isWritable: true },
      { pubkey: input.bridge, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }
    ],
    data: encodeProveMessage(input)
  });

  const tx = await createBaseClaimTransaction(input.connection, input.payer, transfer, mintInfo.owner);
  tx.add(proveIx, createRelayInstruction(program, input.incomingMessage, input.bridge, transfer, tokenVault, mintInfo.owner));
  return { transaction: tx, transfer };
}

export async function buildRelayOnlyTransaction(input: {
  connection: Connection;
  programId: string;
  payer: PublicKey;
  incomingMessage: PublicKey;
  bridge: PublicKey;
  data: Hex;
}): Promise<{ transaction: Transaction; transfer: ParsedTransfer }> {
  const transfer = parseBaseToSolanaTransfer(input.data);
  const mintInfo = await readMintInfo(input.connection, transfer.localMint);
  assertRecipientWallet(input.payer, transfer, mintInfo.owner);
  const tokenVault = getTokenVaultPda(input.programId, transfer.localMint, transfer.remoteToken);
  const program = new PublicKey(input.programId);
  const tx = await createBaseClaimTransaction(input.connection, input.payer, transfer, mintInfo.owner);
  tx.add(createRelayInstruction(program, input.incomingMessage, input.bridge, transfer, tokenVault, mintInfo.owner));
  return { transaction: tx, transfer };
}

export function incomingMessageAccountSpace(data: Hex): number {
  return 8 + 20 + 4 + hexToBytes(data).length + 1;
}

export function readIncomingMessageExecuted(accountData: Buffer | Uint8Array, messageData: Hex): boolean {
  // The program overallocates IncomingMessage by 4 bytes, but the `message`
  // field itself is a Borsh enum, not a Vec. The executed flag is serialized
  // immediately after the raw Message bytes.
  const executedOffset = 8 + 20 + hexToBytes(messageData).length;
  if (accountData.length <= executedOffset) throw new Error("The Solana incoming message account has an unexpected layout.");
  return accountData[executedOffset] === 1;
}

function assertRecipientWallet(payer: PublicKey, transfer: ParsedTransfer, tokenProgram: PublicKey): void {
  const expectedAta = deriveAta(payer, transfer.localMint, tokenProgram);
  if (!expectedAta.equals(transfer.toTokenAccount)) {
    throw new Error(
      `Connect the Solana wallet that owns the destination token account ${transfer.toTokenAccount.toBase58()}.`
    );
  }
}

async function createBaseClaimTransaction(
  connection: Connection,
  payer: PublicKey,
  transfer: ParsedTransfer,
  tokenProgram: PublicKey
): Promise<Transaction> {
  const latest = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({
    feePayer: payer,
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight
  });
  tx.add(createAtaIdempotentIx(payer, transfer.toTokenAccount, payer, transfer.localMint, tokenProgram));
  return tx;
}

export function createRelayInstruction(
  program: PublicKey,
  incomingMessage: PublicKey,
  bridge: PublicKey,
  transfer: ParsedTransfer,
  tokenVault: PublicKey,
  tokenProgram: PublicKey
): TransactionInstruction {
  return new TransactionInstruction({
    programId: program,
    keys: [
      { pubkey: incomingMessage, isSigner: false, isWritable: true },
      { pubkey: bridge, isSigner: false, isWritable: false },
      { pubkey: transfer.localMint, isSigner: false, isWritable: false },
      { pubkey: tokenVault, isSigner: false, isWritable: true },
      { pubkey: transfer.toTokenAccount, isSigner: false, isWritable: true },
      { pubkey: tokenProgram, isSigner: false, isWritable: false }
    ],
    data: RELAY_MESSAGE_DISCRIMINATOR
  });
}

function createAtaIdempotentIx(
  payer: PublicKey,
  associatedToken: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
  tokenProgram: PublicKey
): TransactionInstruction {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: associatedToken, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false }
    ],
    data: CREATE_IDEMPOTENT_ATA_DISCRIMINATOR
  });
}

export function encodeProveMessage(input: {
  nonce: bigint;
  sender: Hex;
  data: Hex;
  proof: readonly Hex[];
  messageHash: Hex;
}): Buffer {
  return Buffer.concat([
    PROVE_MESSAGE_DISCRIMINATOR,
    u64Le(input.nonce),
    Buffer.from(hexToBytes(input.sender)),
    vecU8(Buffer.from(hexToBytes(input.data))),
    vecFixed32(input.proof.map((item) => Buffer.from(hexToBytes(item)))),
    Buffer.from(hexToBytes(input.messageHash))
  ]);
}

export function getBlockheightConfirmationStrategy(transaction: Transaction, signature: string) {
  const blockhash = transaction.recentBlockhash;
  const lastValidBlockHeight = transaction.lastValidBlockHeight;
  if (!blockhash || lastValidBlockHeight === undefined) {
    throw new Error("The Solana transaction is missing its blockhash expiry information. Rebuild the claim and retry.");
  }
  return { signature, blockhash, lastValidBlockHeight };
}

function vecU8(bytes: Buffer): Buffer {
  return Buffer.concat([u32Le(bytes.length), bytes]);
}

function vecFixed32(items: Buffer[]): Buffer {
  return Buffer.concat([u32Le(items.length), ...items]);
}

function u32Le(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value);
  return buffer;
}

function u64Le(value: bigint): Buffer {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(value);
  return buffer;
}
