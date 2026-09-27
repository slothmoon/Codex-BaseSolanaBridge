import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { address, getBase64Decoder, type Address } from "@solana/kit";
import type { Hex } from "viem";
import { describe, it } from "vitest";

import { NETWORK } from "../../src/config";
import { generateProof, getBaseClient, lookupBridgeTransaction } from "../../src/chain/base";
import { fetchAccounts, getSolanaRpc } from "../../src/chain/solana";
import { decodeBridgeAccount, decodeTokenAccount } from "../../src/protocol/accounts";
import { findBridgePda, findIncomingMessagePda, findOutputRootPda, findSolVaultPda, findTokenVaultPda } from "../../src/protocol/instructions";

// Regenerates tests/fixtures/mainnet.json from live mainnet (read-only):
//   CAPTURE_FIXTURES=1 npx vitest run --project live capture-fixtures

const MESSAGES: Hex[] = [
  "0x849914757db9cf3c60f61d2f653221af69e0f02b48ea86fb6d4cd4eb9840af01", // SPL (neet)
  "0xf2934bd1e9008d071a9aea5f0b087cc05a2bd3bf8eb22169f07b205a1ca6b603", // SPL (JitoSOL)
  "0x8b6567477603ee5747b7202178192aeddbf4d6040fee6683ac51b3c962b50914", // SOL
  "0x6cfc74a08fc5093cfa94eabcc758ac65bc3d5fc84b0467e53e846331ab2f8a13" // wrapped token
];

const MINTS: Address[] = [
  address("J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn"), // JitoSOL, Token
  address("2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo") // PYUSD, Token-2022 with extensions
];

const b64 = getBase64Decoder();
const toBase64 = (bytes: Uint8Array) => b64.decode(bytes);

describe.runIf(process.env.CAPTURE_FIXTURES === "1")("capture mainnet fixtures", () => {
  it("writes tests/fixtures/mainnet.json", async () => {
    const rpc = getSolanaRpc();
    const base = getBaseClient();
    const program = NETWORK.solana.bridgeProgram;

    const bridgePda = await findBridgePda(program);
    const [bridge] = await fetchAccounts(rpc, [bridgePda]);
    const bridgeState = decodeBridgeAccount(bridge!.data);
    const rootBlock = bridgeState.baseBlockNumber;
    const outputRootPda = await findOutputRootPda(program, rootBlock);
    const [outputRoot] = await fetchAccounts(rpc, [outputRootPda]);

    const messages = [];
    for (const txHash of MESSAGES) {
      const lookup = await lookupBridgeTransaction(base, txHash);
      if (lookup.status !== "found") throw new Error(`${txHash}: ${lookup.status}`);
      const incoming = await findIncomingMessagePda(program, lookup.event.messageHash);
      const [incomingAccount] = await fetchAccounts(rpc, [incoming]);
      const proof = await generateProof(base, lookup.event.nonce, rootBlock);
      messages.push({
        txHash,
        baseBlock: lookup.blockNumber.toString(),
        from: lookup.from,
        messageHash: lookup.event.messageHash,
        nonce: lookup.event.nonce.toString(),
        sender: lookup.event.sender,
        data: lookup.event.data,
        incomingMessage: { address: incoming, owner: incomingAccount!.owner, data: toBase64(incomingAccount!.data) },
        proof
      });
    }

    const mints = [];
    for (const mint of MINTS) {
      const [account] = await fetchAccounts(rpc, [mint]);
      mints.push({ address: mint, owner: account!.owner, data: toBase64(account!.data) });
    }

    const jitoVault = await findTokenVaultPda(program, MINTS[0], "0x97bE14Dd8f994A5364573BC035D85309E7CB34de");
    const [vault] = await fetchAccounts(rpc, [jitoVault]);
    decodeTokenAccount(vault!.data);
    const solVault = await findSolVaultPda(program);
    const [solVaultAccount] = await fetchAccounts(rpc, [solVault]);

    const fixture = {
      capturedAt: new Date().toISOString(),
      program,
      bridge: { address: bridgePda, data: toBase64(bridge!.data) },
      outputRoot: { address: outputRootPda, block: rootBlock.toString(), data: toBase64(outputRoot!.data) },
      messages,
      mints,
      vaults: [{ address: jitoVault, mint: MINTS[0], baseToken: "0x97bE14Dd8f994A5364573BC035D85309E7CB34de", owner: vault!.owner, data: toBase64(vault!.data) }],
      solVault: { address: solVault, lamports: solVaultAccount!.lamports.toString() }
    };
    writeFileSync(resolve(__dirname, "../fixtures/mainnet.json"), JSON.stringify(fixture, null, 2) + "\n");
  });
});
