import { AccountRole, getProgramDerivedAddress, type AccountMeta, type Address, type Instruction } from "@solana/kit";
import { hexToBytes, type Hex } from "viem";

import { addressToBytes, concatBytes, u32le, u64le } from "./bytes";
import { INSTRUCTION_DISCRIMINATORS, SEEDS, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM } from "./constants";
import type { BridgeTransfer } from "./message";

// ---------------------------------------------------------------------------------------------
// PDAs
// ---------------------------------------------------------------------------------------------

async function pda(program: Address, seeds: Uint8Array[]): Promise<Address> {
  const [value] = await getProgramDerivedAddress({ programAddress: program, seeds });
  return value;
}

export const findBridgePda = (program: Address) => pda(program, [SEEDS.bridge]);
export const findSolVaultPda = (program: Address) => pda(program, [SEEDS.solVault]);
export const findOutputRootPda = (program: Address, baseBlockNumber: bigint) => pda(program, [SEEDS.outputRoot, u64le(baseBlockNumber)]);
export const findIncomingMessagePda = (program: Address, messageHash: Hex) => pda(program, [SEEDS.incomingMessage, hexToBytes(messageHash)]);
export const findTokenVaultPda = (program: Address, mint: Address, baseToken: Hex) =>
  pda(program, [SEEDS.tokenVault, addressToBytes(mint), hexToBytes(baseToken)]);

// ---------------------------------------------------------------------------------------------
// Instructions (account order and Borsh argument layout from the official IDL)
// ---------------------------------------------------------------------------------------------

const meta = (address: Address, role: AccountRole): AccountMeta => ({ address, role });
const vecU8 = (bytes: Uint8Array) => concatBytes(u32le(bytes.length), bytes);
const vecFixed32 = (items: readonly Hex[]) => concatBytes(u32le(items.length), ...items.map((item) => fixed(item, 32)));

function fixed(value: Hex, length: number): Uint8Array {
  const bytes = hexToBytes(value);
  if (bytes.length !== length) throw new Error(`Expected ${length} bytes, got ${bytes.length}.`);
  return bytes;
}

export type ProveArgs = { nonce: bigint; sender: Hex; data: Uint8Array; proof: readonly Hex[]; messageHash: Hex };

export function proveMessageInstruction(input: ProveArgs & {
  program: Address;
  payer: Address;
  outputRoot: Address;
  message: Address;
  bridge: Address;
}): Instruction {
  return {
    programAddress: input.program,
    accounts: [
      meta(input.payer, AccountRole.WRITABLE_SIGNER),
      meta(input.outputRoot, AccountRole.READONLY),
      meta(input.message, AccountRole.WRITABLE),
      meta(input.bridge, AccountRole.READONLY),
      meta(SYSTEM_PROGRAM, AccountRole.READONLY)
    ],
    data: concatBytes(
      INSTRUCTION_DISCRIMINATORS.proveMessage,
      u64le(input.nonce),
      fixed(input.sender, 20),
      vecU8(input.data),
      vecFixed32(input.proof),
      fixed(input.messageHash, 32)
    )
  };
}

export function relayMessageInstruction(input: {
  program: Address;
  message: Address;
  bridge: Address;
  remainingAccounts: AccountMeta[];
}): Instruction {
  return {
    programAddress: input.program,
    accounts: [meta(input.message, AccountRole.WRITABLE), meta(input.bridge, AccountRole.READONLY), ...input.remainingAccounts],
    data: new Uint8Array(INSTRUCTION_DISCRIMINATORS.relayMessage)
  };
}

/**
 * Remaining accounts `relay_message` hands to the transfer finalizer, in the exact order each
 * `finalize()` reads them (base_to_solana/instructions/token/finalize_*_transfer.rs).
 */
export async function relayRemainingAccounts(program: Address, transfer: BridgeTransfer, tokenProgram: Address | null): Promise<AccountMeta[]> {
  switch (transfer.kind) {
    case "sol":
      return [
        meta(await findSolVaultPda(program), AccountRole.WRITABLE),
        meta(transfer.to, AccountRole.WRITABLE),
        meta(SYSTEM_PROGRAM, AccountRole.READONLY)
      ];
    case "spl":
      if (!tokenProgram) throw new Error("The token program of the SPL mint is required.");
      return [
        meta(transfer.mint, AccountRole.READONLY),
        meta(await findTokenVaultPda(program, transfer.mint, transfer.baseToken), AccountRole.WRITABLE),
        meta(transfer.to, AccountRole.WRITABLE),
        meta(tokenProgram, AccountRole.READONLY)
      ];
    case "wrapped":
      return [
        meta(transfer.mint, AccountRole.WRITABLE),
        meta(transfer.to, AccountRole.WRITABLE),
        meta(TOKEN_2022_PROGRAM, AccountRole.READONLY)
      ];
  }
}
