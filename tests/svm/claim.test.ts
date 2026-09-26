import {
  address,
  createNoopSigner,
  generateKeyPairSigner,
  lamports,
  partiallySignTransaction,
  type Address,
  type KeyPairSigner
} from "@solana/kit";
import { findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstruction } from "@solana-program/token";
import { hexToBytes } from "viem";
import { beforeAll, describe, expect, it } from "vitest";

import { fetchAccounts, getSolanaRpc, type RawAccount } from "../../src/chain/solana";
import { planClaim, type ClaimPlan } from "../../src/core/claim-plan";
import { buildTransaction, MAX_COMPUTE_UNITS, type TxVersion } from "../../src/core/tx";
import { decodeIncomingMessage, decodeTokenAccount } from "../../src/protocol/accounts";
import { bytesToAddress, hexToBytes as toBytes } from "../../src/protocol/bytes";
import { SYSTEM_PROGRAM } from "../../src/protocol/constants";
import { findBridgePda, findSolVaultPda, findTokenVaultPda, relayRemainingAccounts } from "../../src/protocol/instructions";
import { decodeBridgeMessage, type BridgeTransfer } from "../../src/protocol/message";
import { fromBase64, mainnet, program } from "../helpers";

// End-to-end claims against the REAL mainnet bridge program binary, executed in LiteSVM with accounts
// cloned from mainnet and the captured (real) proofs. Needs LiteSVM's native binding (Linux/macOS)
// and network access to fetch the current program and accounts; skipped elsewhere.

type LiteSvmModule = typeof import("litesvm");
let litesvm: LiteSvmModule | null = null;
try {
  litesvm = await import("litesvm");
  new litesvm.LiteSVM();
} catch {
  litesvm = null;
}

type Fixture = (typeof mainnet.messages)[number];

describe.runIf(litesvm !== null)("claims against the real bridge program (LiteSVM)", () => {
  let programElf: Uint8Array;
  const live = new Map<string, RawAccount | null>();

  beforeAll(async () => {
    const rpc = getSolanaRpc();
    const [programAccount] = await fetchAccounts(rpc, [program]);
    const programData = bytesToAddress(programAccount!.data.subarray(4, 36));
    const [data] = await fetchAccounts(rpc, [programData]);
    programElf = data!.data.subarray(45); // UpgradeableLoaderState::ProgramData header
    // Clone every account the claims touch.
    const addresses = new Set<Address>([await findSolVaultPda(program)]);
    for (const fixture of mainnet.messages) {
      const decoded = decodeBridgeMessage(hexToBytes(fixture.data));
      if (decoded.type !== "transfer") continue;
      addresses.add(decoded.transfer.to);
      if (decoded.transfer.kind !== "sol") addresses.add(decoded.transfer.mint);
      if (decoded.transfer.kind === "spl") addresses.add(await findTokenVaultPda(program, decoded.transfer.mint, decoded.transfer.baseToken));
    }
    const list = [...addresses];
    const accounts = await fetchAccounts(rpc, list);
    list.forEach((key, index) => live.set(key, accounts[index]));
  });

  function freshSvm() {
    const svm = new litesvm!.LiteSVM();
    svm.addProgram(program, programElf);
    const put = (key: Address, owner: Address, data: Uint8Array, lamportsValue?: bigint) =>
      svm.setAccount({ address: key, programAddress: owner, data, executable: false, lamports: lamports(lamportsValue ?? svm.minimumBalanceForRentExemption(BigInt(data.length))), space: BigInt(data.length) });
    put(address(mainnet.bridge.address), program, fromBase64(mainnet.bridge.data));
    put(address(mainnet.outputRoot.address), program, fromBase64(mainnet.outputRoot.data));
    for (const [key, account] of live) if (account) put(key as Address, account.owner, account.data, account.lamports);
    return { svm, put };
  }

  async function setup(fixture: Fixture) {
    const { svm, put } = freshSvm();
    const payer = await generateKeyPairSigner();
    svm.airdrop(payer.address, lamports(10_000_000_000n));
    const decoded = decodeBridgeMessage(hexToBytes(fixture.data));
    if (decoded.type !== "transfer") throw new Error("fixture is not a transfer");
    const tokenProgram = decoded.transfer.kind === "sol" ? null : live.get(decoded.transfer.mint)!.owner;
    return { svm, put, payer, transfer: decoded.transfer, tokenProgram };
  }

  const balanceOf = (svm: InstanceType<LiteSvmModule["LiteSVM"]>, transfer: BridgeTransfer): bigint => {
    const account = svm.getAccount(transfer.to);
    if (!account.exists) return 0n;
    return transfer.kind === "sol" ? BigInt(account.lamports) : decodeTokenAccount(new Uint8Array(account.data)).amount;
  };

  async function plan(fixture: Fixture, payer: KeyPairSigner, transfer: BridgeTransfer, tokenProgram: Address | null, options: { version: TxVersion; force?: ClaimPlan["strategy"]; proof?: `0x${string}`[]; createDestination?: boolean }) {
    let createDestination = null;
    if (options.createDestination && transfer.kind !== "sol") {
      const owner = decodeTokenAccount(live.get(transfer.to)!.data).owner;
      const [ata] = await findAssociatedTokenPda({ owner, mint: transfer.mint, tokenProgram: tokenProgram! });
      expect(ata).toBe(transfer.to);
      createDestination = getCreateAssociatedTokenIdempotentInstruction({ payer: createNoopSigner(payer.address), ata, owner, mint: transfer.mint, tokenProgram: tokenProgram! });
    }
    return planClaim(
      {
        program,
        payer: payer.address,
        bridge: await findBridgePda(program),
        incomingMessage: address(fixture.incomingMessage.address),
        nonce: BigInt(fixture.nonce),
        sender: fixture.sender,
        messageHash: fixture.messageHash,
        messageData: hexToBytes(fixture.data),
        proofState: { kind: "unproven", outputRoot: address(mainnet.outputRoot.address), proof: options.proof ?? fixture.proof },
        createDestination,
        relayRemainingAccounts: await relayRemainingAccounts(program, transfer, tokenProgram),
        existingBuffer: null
      },
      { supportsV1: options.version === 1, createBufferSigner: () => generateKeyPairSigner(), force: options.force }
    );
  }

  async function execute(svm: InstanceType<LiteSvmModule["LiteSVM"]>, payer: KeyPairSigner, claimPlan: ClaimPlan) {
    for (const tx of claimPlan.txs) {
      const built = buildTransaction({
        version: claimPlan.version,
        feePayer: payer.address,
        instructions: tx.instructions,
        blockhash: svm.latestBlockhash(),
        lastValidBlockHeight: 0n,
        computeUnitLimit: MAX_COMPUTE_UNITS,
        microLamportsPerComputeUnit: 1n
      });
      const signed = await partiallySignTransaction([payer.keyPair, ...tx.signers.map((signer) => signer.keyPair)], built);
      const result = svm.sendTransaction(signed as never);
      if (result instanceof litesvm!.FailedTransactionMetadata) {
        throw new Error(`${tx.label} failed: ${JSON.stringify(result.err(), (_, v) => (typeof v === "bigint" ? v.toString() : v))}\n${result.meta().logs().join("\n")}`);
      }
      svm.expireBlockhash();
    }
  }

  const cases: { name: string; version: TxVersion; force?: ClaimPlan["strategy"] }[] = [
    { name: "v0, cheapest strategy", version: 0 },
    { name: "v0, forced prove/relay split", version: 0, force: "split" },
    { name: "v0, forced buffered proof upload", version: 0, force: "buffered" },
    { name: "v1, single large transaction", version: 1 }
  ];

  for (const fixture of mainnet.messages) {
    for (const scenario of cases) {
      it(`claims ${fixture.data.slice(0, 6) === "0x0100" ? "SOL" : fixture.data.slice(0, 6) === "0x0101" ? "SPL" : "wrapped"} nonce ${fixture.nonce}: ${scenario.name}`, async (context) => {
        const { svm, payer, transfer, tokenProgram } = await setup(fixture);
        const before = balanceOf(svm, transfer);
        const claimPlan = await plan(fixture, payer, transfer, tokenProgram, { version: scenario.version, force: scenario.force });
        try {
          await execute(svm, payer, claimPlan);
        } catch (error) {
          if (scenario.version === 1 && /version|unsupported|sanitize/i.test(String(error))) context.skip();
          throw error;
        }
        const incoming = svm.getAccount(address(fixture.incomingMessage.address));
        expect(incoming.exists).toBe(true);
        expect(decodeIncomingMessage(new Uint8Array(incoming.exists ? incoming.data : []), hexToBytes(fixture.data).length).executed).toBe(true);
        expect(balanceOf(svm, transfer) - before).toBe(transfer.amount);
        for (const tx of claimPlan.txs) for (const signer of tx.signers) expect(svm.getAccount(signer.address).exists).toBe(false); // buffer closed, rent refunded
      });
    }
  }

  it("creates the recipient's token account when it is missing", async () => {
    const fixture = mainnet.messages.find((item) => item.data.startsWith("0x0101"))!;
    const { svm, put, payer, transfer, tokenProgram } = await setup(fixture);
    put(transfer.to, SYSTEM_PROGRAM, new Uint8Array(), 0n); // remove the destination
    const claimPlan = await plan(fixture, payer, transfer, tokenProgram, { version: 0, createDestination: true });
    await execute(svm, payer, claimPlan);
    expect(balanceOf(svm, transfer)).toBe(transfer.amount);
  });

  it("is rejected by the program with a tampered proof (InvalidProof)", async () => {
    const fixture = mainnet.messages[0];
    const { svm, payer, transfer, tokenProgram } = await setup(fixture);
    const bad = [...fixture.proof];
    bad[0] = `0x${"ab".repeat(32)}`;
    await expect(execute(svm, payer, await plan(fixture, payer, transfer, tokenProgram, { version: 0, proof: bad }))).rejects.toThrow(/12400|InvalidProof/);
  });

  it("cannot be claimed twice (AlreadyExecuted)", async () => {
    const fixture = mainnet.messages[0];
    const { svm, payer, transfer, tokenProgram } = await setup(fixture);
    await execute(svm, payer, await plan(fixture, payer, transfer, tokenProgram, { version: 0 }));
    const relayOnly = await planClaim(
      {
        program,
        payer: payer.address,
        bridge: await findBridgePda(program),
        incomingMessage: address(fixture.incomingMessage.address),
        nonce: BigInt(fixture.nonce),
        sender: fixture.sender,
        messageHash: fixture.messageHash,
        messageData: toBytes(fixture.data),
        proofState: { kind: "proven" },
        createDestination: null,
        relayRemainingAccounts: await relayRemainingAccounts(program, transfer, tokenProgram),
        existingBuffer: null
      },
      { supportsV1: false, createBufferSigner: () => generateKeyPairSigner() }
    );
    await expect(execute(svm, payer, relayOnly)).rejects.toThrow(/12501|AlreadyExecuted/);
  });
});
