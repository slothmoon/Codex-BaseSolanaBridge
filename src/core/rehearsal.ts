import { AccountRole, createNoopSigner, getBase64EncodedWireTransaction, getBase64Encoder, type Address, type Instruction } from "@solana/kit";
import { getCreateAssociatedTokenIdempotentInstruction, getTransferCheckedInstruction } from "@solana-program/token";

import { NETWORK } from "../config";
import { fetchAccounts, type SolanaRpc } from "../chain/solana";
import { concatBytes, u32le, u64le } from "../protocol/bytes";
import { decodeTokenAccount } from "../protocol/accounts";
import { SYSTEM_PROGRAM } from "../protocol/constants";
import { findSolVaultPda } from "../protocol/instructions";
import { buildTransaction, PLACEHOLDER_BLOCKHASH } from "./tx";

/**
 * A dry run of the exact token movement the bridge performs when a claim is relayed:
 * `transfer_checked` from the bridge vault (signed by the vault PDA) into the recipient's account,
 * creating that account first if it does not exist. SOL returns rehearse the system transfer out of
 * the SOL vault instead.
 *
 * It is simulated with signature verification off, so the vault PDA can "sign", and paid for by the
 * bridge's SOL vault (a funded system account) so no user funds are involved. Because the token
 * program itself decides the outcome, this covers transfer hooks, pauses, frozen accounts, memo
 * requirements, non-transferable mints, transfer fees and any Token-2022 feature added in future,
 * without this app having to understand them. It proves the release works *now*; it cannot promise
 * the issuer will not change the token's settings before the claim.
 */
export type ReleaseRehearsal =
  | { ok: true; received: bigint; destinationSpace: number }
  | { ok: false; reason: string; logs: readonly string[] };

export type RehearsalInput =
  | { kind: "sol"; rpc: SolanaRpc; amount: bigint; recipient: Address }
  | {
      kind: "spl";
      rpc: SolanaRpc;
      amount: bigint;
      mint: Address;
      decimals: number;
      tokenProgram: Address;
      vault: Address;
      /** The recipient's token account (the `to` fixed at burn time). */
      destination: Address;
      /** Set when `destination` does not exist yet and will be created as this wallet's associated token account. */
      createForOwner: Address | null;
    };

const SIMULATION_COMPUTE_UNITS = 400_000;

export async function rehearseRelease(input: RehearsalInput): Promise<ReleaseRehearsal> {
  const solVault = await findSolVaultPda(NETWORK.solana.bridgeProgram);
  const destination = input.kind === "sol" ? input.recipient : input.destination;
  const [before] = await fetchAccounts(input.rpc, [destination]);

  const instructions: Instruction[] =
    input.kind === "sol"
      ? [systemTransfer(solVault, input.recipient, input.amount)]
      : [
          ...(input.createForOwner
            ? [
                getCreateAssociatedTokenIdempotentInstruction({
                  payer: createNoopSigner(solVault),
                  ata: input.destination,
                  owner: input.createForOwner,
                  mint: input.mint,
                  tokenProgram: input.tokenProgram
                })
              ]
            : []),
          getTransferCheckedInstruction(
            { source: input.vault, mint: input.mint, destination: input.destination, authority: createNoopSigner(input.vault), amount: input.amount, decimals: input.decimals },
            { programAddress: input.tokenProgram }
          )
        ];

  // The simulation substitutes a recent blockhash (replaceRecentBlockhash), so none needs fetching.
  const transaction = buildTransaction({
    version: 0,
    feePayer: solVault,
    instructions,
    blockhash: PLACEHOLDER_BLOCKHASH,
    lastValidBlockHeight: 0n,
    computeUnitLimit: SIMULATION_COMPUTE_UNITS,
    microLamportsPerComputeUnit: 1n
  });
  const { value } = await input.rpc
    .simulateTransaction(getBase64EncodedWireTransaction(transaction), {
      encoding: "base64",
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: "confirmed",
      accounts: { encoding: "base64", addresses: [destination] }
    })
    .send();

  const logs = value.logs ?? [];
  if (value.err) return { ok: false, reason: reasonFromLogs(logs, value.err), logs };

  const after = value.accounts?.[0] as { lamports: bigint | number; data: readonly [string, string] } | null | undefined;
  if (!after) return { ok: false, reason: "The dry run did not return the destination account.", logs };
  const afterData = new Uint8Array(getBase64Encoder().encode(after.data[0]));

  if (input.kind === "sol") {
    return { ok: true, received: BigInt(after.lamports) - (before?.lamports ?? 0n), destinationSpace: afterData.length };
  }
  const beforeAmount = before ? decodeTokenAccount(before.data).amount : 0n;
  return { ok: true, received: decodeTokenAccount(afterData).amount - beforeAmount, destinationSpace: afterData.length };
}

function systemTransfer(from: Address, to: Address, lamports: bigint): Instruction {
  return {
    programAddress: SYSTEM_PROGRAM,
    accounts: [
      { address: from, role: AccountRole.WRITABLE_SIGNER },
      { address: to, role: AccountRole.WRITABLE }
    ],
    data: concatBytes(u32le(2), u64le(lamports))
  };
}

/** The token and system programs log a human-readable reason; prefer it over the raw error code. */
function reasonFromLogs(logs: readonly string[], error: unknown): string {
  // The program's own message ("Program log: Error: insufficient funds") comes before the runtime's
  // generic "failed: custom program error: 0x1" line, so prefer it.
  const programMessage = [...logs].reverse().find((entry) => /^Program log: Error:/i.test(entry));
  if (programMessage) return programMessage.replace(/^Program log: Error:\s*/i, "");
  const failure = [...logs].reverse().find((entry) => /failed:/i.test(entry));
  if (failure) return failure.replace(/^Program \w+ /, "").trim();
  return JSON.stringify(error, (_, inner) => (typeof inner === "bigint" ? inner.toString() : inner));
}
