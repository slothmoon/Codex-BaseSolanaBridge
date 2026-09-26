import { address, generateKeyPairSigner, getBase64EncodedWireTransaction, type Address, type Instruction } from "@solana/kit";
import { hexToBytes, type Hex } from "viem";
import { describe, expect, it } from "vitest";

import { NETWORK } from "../../src/config";
import { generateProof, getBaseArchiveClient, getBaseClient } from "../../src/chain/base";
import { findUpgradedComponents } from "../../src/chain/pins";
import { fetchAccounts, getSolanaRpc } from "../../src/chain/solana";
import { inspectToken } from "../../src/core/route";
import { loadBridgeState, trackTransaction } from "../../src/core/status";
import { buildTransaction, MAX_COMPUTE_UNITS, type TxVersion } from "../../src/core/tx";
import { decodeOutputRoot } from "../../src/protocol/accounts";
import {
  appendToProveBufferDataInstruction,
  appendToProveBufferProofInstruction,
  findOutputRootPda,
  initializeProveBufferInstruction,
  relayMessageInstruction,
  relayRemainingAccounts
} from "../../src/protocol/instructions";
import { decodeBridgeMessage } from "../../src/protocol/message";
import { verifyMmrProof } from "../../src/protocol/mmr";
import { mainnet } from "../helpers";

// Read-only checks against live mainnet. Nothing is signed or sent: transactions are only simulated
// (signature verification off) with a well-funded existing account as the fee payer.
// Run with: npm run test:live

const FUNDED_FEE_PAYER = address("DZaZMpR6ZBNPKBqaweGnoPP3QLq3pyoRTDfBpYS1QMU2");
const rpc = getSolanaRpc();
const base = getBaseClient();

async function simulate(version: TxVersion, instructions: Instruction[], feePayer: Address = FUNDED_FEE_PAYER) {
  const { value: latest } = await rpc.getLatestBlockhash().send();
  const tx = buildTransaction({ version, feePayer, instructions, blockhash: latest.blockhash, lastValidBlockHeight: BigInt(latest.lastValidBlockHeight), computeUnitLimit: MAX_COMPUTE_UNITS, microLamportsPerComputeUnit: 1_000n });
  const { value } = await rpc.simulateTransaction(getBase64EncodedWireTransaction(tx), { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" }).send();
  return value;
}

describe.runIf(NETWORK.id === "mainnet")("live mainnet", () => {
  it("runs against the exact deployments this interface was verified with", async () => {
    expect(await findUpgradedComponents(base, rpc)).toEqual([]);
  });

  it("inspects real official wrappers with no blocking findings", async () => {
    for (const token of [NETWORK.base.solWrapper, "0x97bE14Dd8f994A5364573BC035D85309E7CB34de"]) {
      const inspection = await inspectToken({ token, holder: null, base, rpc });
      expect(inspection.findings.filter((finding) => finding.level === "block"), token).toEqual([]);
      expect(inspection.vault.balance).toBeGreaterThan(0n);
    }
  });

  it("refuses a non-bridge ERC-20 (USDC)", async () => {
    await expect(inspectToken({ token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", holder: null, base, rpc })).rejects.toThrow(/official Base bridge factory/);
  });

  it("tracks real returns as claimed", async () => {
    for (const fixture of mainnet.messages) {
      const status = await trackTransaction({ txHash: fixture.txHash, base, rpc });
      expect(status.state, fixture.txHash).toBe("claimed");
    }
  });

  it("generates proofs that verify against today's on-chain root", async () => {
    const bridge = await loadBridgeState(rpc);
    const [account] = await fetchAccounts(rpc, [await findOutputRootPda(NETWORK.solana.bridgeProgram, bridge.account.baseBlockNumber)]);
    const root = decodeOutputRoot(account!.data);
    for (const fixture of mainnet.messages) {
      const proof = await generateProof(getBaseArchiveClient(), BigInt(fixture.nonce), bridge.account.baseBlockNumber);
      expect(verifyMmrProof({ root: root.root, leafHash: fixture.messageHash as Hex, leafIndex: BigInt(fixture.nonce), proof, totalLeafCount: root.totalLeafCount })).toBe(true);
    }
  });

  it.each([0, 1] as const)("gets a real relay (v%s) through account validation to the program's AlreadyExecuted check", async (version) => {
    const bridge = await loadBridgeState(rpc);
    for (const fixture of mainnet.messages) {
      const decoded = decodeBridgeMessage(hexToBytes(fixture.data));
      if (decoded.type !== "transfer") continue;
      const mint = decoded.transfer.kind === "sol" ? null : decoded.transfer.mint;
      const [mintAccount] = mint ? await fetchAccounts(rpc, [mint]) : [null];
      const relay = relayMessageInstruction({
        program: NETWORK.solana.bridgeProgram,
        message: address(fixture.incomingMessage.address),
        bridge: bridge.pda,
        remainingAccounts: await relayRemainingAccounts(NETWORK.solana.bridgeProgram, decoded.transfer, mintAccount?.owner ?? null)
      });
      const result = await simulate(version, [relay]);
      expect(result.err, fixture.txHash).toEqual({ InstructionError: [version === 0 ? 2n : 0n, { Custom: 12501n }] });
      expect((result.logs ?? []).join("\n")).toMatch(/AlreadyExecuted/);
    }
  });

  it.each([0, 1] as const)("creates and fills a prove buffer on the real program (v%s)", async (version) => {
    const bridge = await loadBridgeState(rpc);
    const buffer = await generateKeyPairSigner();
    const fixture = mainnet.messages[1];
    const program = NETWORK.solana.bridgeProgram;
    const data = hexToBytes(fixture.data);
    const result = await simulate(version, [
      initializeProveBufferInstruction({ program, payer: FUNDED_FEE_PAYER, bridge: bridge.pda, buffer: buffer.address, maxDataLength: data.length, maxProofLength: fixture.proof.length }),
      appendToProveBufferDataInstruction({ program, owner: FUNDED_FEE_PAYER, buffer: buffer.address, chunk: data }),
      appendToProveBufferProofInstruction({ program, owner: FUNDED_FEE_PAYER, buffer: buffer.address, proof: fixture.proof })
    ]);
    expect(result.err, (result.logs ?? []).join("\n")).toBeNull();
    const logs = (result.logs ?? []).join("\n");
    expect(logs).toMatch(/InitializeProveBuffer/);
    expect(logs).toMatch(/AppendToProveBufferData/);
    expect(logs).toMatch(/AppendToProveBufferProof/);
  });
});
