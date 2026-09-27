import { address, decompileTransactionMessage, getBase64Encoder, getCompiledTransactionMessageDecoder, getTransactionDecoder, type Instruction, type Transaction } from "@solana/kit";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { describe, expect, it } from "vitest";

import { buildRoute } from "../../src/core/route";
import { rehearseRelease } from "../../src/core/rehearsal";
import { decodeMint } from "../../src/protocol/accounts";
import { concatBytes, u64le } from "../../src/protocol/bytes";
import { SYSTEM_PROGRAM } from "../../src/protocol/constants";
import { findSolVaultPda } from "../../src/protocol/instructions";
import { TOKEN_2022_WARNING } from "../../src/core/route";
import { mainnet, program } from "../helpers";

/** A minimal initialized mint (82-byte base, padded to 165, account type 1). */
function mintWith(): Uint8Array {
  const base = new Uint8Array(165);
  base[44] = 6; // decimals
  base[45] = 1; // initialized
  return concatBytes(base, [1]);
}

describe("Token-2022 warning", () => {
  it("is a simple small-amount-first warning, never a blocker", () => {
    expect(TOKEN_2022_WARNING).toMatchObject({ level: "warn", code: "token-2022" });
    expect(TOKEN_2022_WARNING.message).toMatch(/test with a small amount first/);
  });
});

// ---------------------------------------------------------------------------------------------
// Release dry run, with a fake RPC that records the simulated transaction
// ---------------------------------------------------------------------------------------------

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const tokenAccount = (amount: bigint) => {
  const data = new Uint8Array(165);
  data.set(u64le(amount), 64);
  data[108] = 1;
  return data;
};

function fakeRpc(options: { existing?: Record<string, Uint8Array>; simulate: (tx: Transaction) => { err: unknown; logs?: string[]; post?: Uint8Array } }) {
  const calls: Transaction[] = [];
  const rpc = {
    getMultipleAccounts: (keys: string[]) => ({
      send: async () => ({ value: keys.map((key) => (options.existing?.[key] ? { owner: TOKEN_PROGRAM_ADDRESS, lamports: 2_039_280n, executable: false, data: [b64(options.existing[key]), "base64"] } : null)) })
    }),
    getLatestBlockhash: () => ({ send: async () => ({ value: { blockhash: "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi", lastValidBlockHeight: 1n } }) }),
    getMinimumBalanceForRentExemption: () => ({ send: async () => 890_880n }),
    simulateTransaction: (wire: string) => ({
      send: async () => {
        const tx = getTransactionDecoder().decode(new Uint8Array(getBase64Encoder().encode(wire))) as Transaction;
        calls.push(tx);
        const result = options.simulate(tx);
        return { value: { err: result.err, logs: result.logs ?? [], accounts: result.post ? [{ lamports: 2_039_280n, data: [b64(result.post), "base64"] }] : [null] } };
      }
    })
  };
  return { rpc: rpc as never, calls };
}

const messageOf = (tx: Transaction) => {
  const message = decompileTransactionMessage(getCompiledTransactionMessageDecoder().decode(tx.messageBytes));
  return { feePayer: message.feePayer, instructions: message.instructions as readonly Instruction[] };
};

describe("release dry run", () => {
  const mint = address("J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn");
  const vault = address(mainnet.vaults[0].address);
  const owner = address("DZaZMpR6ZBNPKBqaweGnoPP3QLq3pyoRTDfBpYS1QMU2");

  it("simulates the vault's own transfer, paid by the bridge's SOL vault, creating the account only when needed", async () => {
    const [ata] = await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const { rpc, calls } = fakeRpc({ simulate: () => ({ err: null, post: tokenAccount(5n) }) });
    const result = await rehearseRelease({ kind: "spl", rpc, amount: 5n, mint, decimals: 9, tokenProgram: TOKEN_PROGRAM_ADDRESS, vault, destination: ata, createForOwner: owner });
    expect(result).toMatchObject({ ok: true, received: 5n });

    const message = messageOf(calls[0]);
    expect(message.feePayer.address).toBe(await findSolVaultPda(program));
    const programs = message.instructions.map((ix) => ix.programAddress);
    expect(programs.slice(-2)).toEqual(["ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", TOKEN_PROGRAM_ADDRESS]);
    const transfer = message.instructions.at(-1)!;
    expect(transfer.data![0]).toBe(12); // TransferChecked
    expect(transfer.accounts!.map((meta) => meta.address)).toEqual([vault, mint, ata, vault]); // source, mint, destination, authority = vault PDA

    const { rpc: rpc2, calls: calls2 } = fakeRpc({ existing: { [ata]: tokenAccount(100n) }, simulate: () => ({ err: null, post: tokenAccount(105n) }) });
    const existing = await rehearseRelease({ kind: "spl", rpc: rpc2, amount: 5n, mint, decimals: 9, tokenProgram: TOKEN_PROGRAM_ADDRESS, vault, destination: ata, createForOwner: null });
    expect(existing).toMatchObject({ ok: true, received: 5n }); // the delta, not the balance
    expect(messageOf(calls2[0]).instructions.some((ix) => ix.programAddress === "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")).toBe(false);
  });

  it("reports the token program's own reason when the release would fail", async () => {
    const { rpc } = fakeRpc({ simulate: () => ({ err: { InstructionError: [2, { Custom: 17 }] }, logs: ["Program log: Instruction: TransferChecked", "Program log: Error: Account is frozen", "Program Tokenkeg consumed 1000 of 200000 compute units"] }) });
    const result = await rehearseRelease({ kind: "spl", rpc, amount: 5n, mint, decimals: 9, tokenProgram: TOKEN_PROGRAM_ADDRESS, vault, destination: owner, createForOwner: null });
    expect(result).toMatchObject({ ok: false, reason: "Account is frozen" });
  });

  it("rehearses SOL as a system transfer out of the SOL vault", async () => {
    const { rpc, calls } = fakeRpc({ simulate: () => ({ err: null, post: new Uint8Array() }) });
    await rehearseRelease({ kind: "sol", rpc, amount: 1_000_000_000n, recipient: owner });
    const ix = messageOf(calls[0]).instructions.at(-1)!;
    expect(ix.programAddress).toBe(SYSTEM_PROGRAM);
    expect(ix.accounts!.map((meta) => meta.address)).toEqual([await findSolVaultPda(program), owner]);
  });
});

describe("route check uses the dry run", () => {
  const mintAddress = address("J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn");
  const recipient = address("DZaZMpR6ZBNPKBqaweGnoPP3QLq3pyoRTDfBpYS1QMU2");
  const inspection = (isToken2022: boolean) => {
    const mint = decodeMint(mintWith());
    return {
      wrapper: { address: "0x97bE14Dd8f994A5364573BC035D85309E7CB34de", remoteToken: "0x00", decimals: 6, symbol: "T", balance: 10n ** 12n },
      kind: "spl",
      mint: { address: mintAddress, tokenProgram: TOKEN_PROGRAM_ADDRESS, account: mint, isToken2022 },
      vault: { address: address(mainnet.vaults[0].address), balance: 10n ** 12n },
      findings: isToken2022 ? [TOKEN_2022_WARNING] : []
    } as never;
  };
  const route = (rpc: never, isToken2022 = false) =>
    buildRoute({ inspection: inspection(isToken2022), amountInput: "1", evmAccount: "0x0000000000000000000000000000000000000001", recipientWallet: recipient, base: { simulateContract: async () => ({}) } as never, rpc });

  it("blocks the burn when the dry run fails, quoting the token program", async () => {
    const { rpc } = fakeRpc({ simulate: () => ({ err: { InstructionError: [3, { Custom: 5 }] }, logs: ["Program log: Error: Transfer is disabled for this mint"] }) });
    const result = await route(rpc);
    expect(result.findings.find((finding) => finding.code === "release-dry-run")).toMatchObject({ level: "block", message: expect.stringMatching(/Transfer is disabled for this mint/) });
  });

  it("uses the dry run's received amount and warns when a fee is taken", async () => {
    const { rpc } = fakeRpc({ simulate: () => ({ err: null, post: tokenAccount(990_000n) }) });
    const result = await route(rpc, true);
    expect(result.expectedReceived).toBe(990_000n);
    expect(result.findings.map((finding) => finding.code)).toEqual(["token-2022", "release-shortfall"]);
    expect(result.findings.every((finding) => finding.level === "warn")).toBe(true);
  });
});
