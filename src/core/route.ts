import type { Address as SolanaAddress } from "@solana/kit";
import { findAssociatedTokenPda } from "@solana-program/token";
import { formatUnits, getAddress, parseUnits, type Address, type Hex, type PublicClient } from "viem";

import { NETWORK } from "../config";
import { BRIDGE_ABI, readWrapper, type WrapperInfo } from "../chain/base";
import { fetchAccounts, fetchMinimumRent, type SolanaRpc } from "../chain/solana";
import { addressToBytes32Hex, bytes32HexToAddress } from "../protocol/bytes";
import { decodeMint, decodeTokenAccount, incomingMessageSpace, type MintAccount } from "../protocol/accounts";
import { NATIVE_SOL_REMOTE_TOKEN, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from "../protocol/constants";
import { findSolVaultPda, findTokenVaultPda } from "../protocol/instructions";
import { loadBridgeState } from "./status";
import { UserFacingError } from "./errors";
import { rehearseRelease } from "./rehearsal";

const U64_MAX = (1n << 64n) - 1n;

/** Serialized length of a plain transfer message: SOL (variant, to, amount, ixs) and SPL (+ Base token, mint). */
const MESSAGE_LENGTH = { sol: 46, spl: 98 } as const;
/** Two transaction signatures plus a typical priority fee. */
const CLAIM_FEE_ALLOWANCE = 20_000n;

export type Finding = { level: "block" | "warn"; code: string; message: string };

/** Shown for every Token-2022 return (same guidance as v1). */
export const TOKEN_2022_WARNING: Finding = {
  level: "warn",
  code: "token-2022",
  message:
    "Token-2022 route: test with a small amount first. Token-2022 extensions can charge transfer fees, change the amount received, or prevent the Solana claim. Confirm a small return reaches your Solana wallet before burning the rest. A failed claim does not undo the Base burn."
};

export type TokenInspection = {
  wrapper: WrapperInfo;
  kind: "spl" | "sol";
  /** SPL mint on Solana (absent for SOL). */
  mint: { address: SolanaAddress; tokenProgram: SolanaAddress; account: MintAccount; isToken2022: boolean } | null;
  vault: { address: SolanaAddress; balance: bigint };
  findings: Finding[];
};

/**
 * Everything that can be checked about a token before any wallet is connected. Runs automatically
 * as soon as an address is entered, so problems show up before the user commits to anything.
 */
export async function inspectToken(input: { token: string; holder: Address | null; base: PublicClient; rpc: SolanaRpc }): Promise<TokenInspection> {
  let token: Address;
  try {
    token = getAddress(input.token.trim());
  } catch {
    throw new UserFacingError("That is not a valid Base token address.");
  }

  const [wrapper, bridgeState] = await Promise.all([readWrapper(input.base, token, input.holder), loadBridgeState(input.rpc)]);
  if (!wrapper.official) {
    throw new UserFacingError(
      "This token was not created by the official Base bridge factory, so it cannot be returned to Solana here. Only Base-wrapped Solana assets (SPL tokens and SOL) can be returned."
    );
  }

  const findings: Finding[] = [];
  if (wrapper.bridgePaused) findings.push({ level: "block", code: "base-paused", message: "The Base side of the bridge is paused. Burns are disabled until it is unpaused." });
  if (bridgeState.account.paused) findings.push({ level: "block", code: "solana-paused", message: "The Solana side of the bridge is paused. Burning now would leave your funds waiting until it is unpaused." });

  const program = NETWORK.solana.bridgeProgram;
  if (wrapper.remoteToken.toLowerCase() === NATIVE_SOL_REMOTE_TOKEN) {
    const vaultAddress = await findSolVaultPda(program);
    const [vault] = await fetchAccounts(input.rpc, [vaultAddress]);
    return { wrapper, kind: "sol", mint: null, vault: { address: vaultAddress, balance: vault?.lamports ?? 0n }, findings };
  }

  const mintAddress = bytes32HexToAddress(wrapper.remoteToken);
  const vaultAddress = await findTokenVaultPda(program, mintAddress, token);
  const [mintAccount, vaultAccount] = await fetchAccounts(input.rpc, [mintAddress, vaultAddress]);
  if (!mintAccount) throw new UserFacingError(`The Solana mint ${mintAddress} behind this wrapper does not exist.`);
  if (mintAccount.owner !== TOKEN_PROGRAM && mintAccount.owner !== TOKEN_2022_PROGRAM) {
    throw new UserFacingError("The Solana mint behind this wrapper uses an unsupported token program.");
  }
  const isToken2022 = mintAccount.owner === TOKEN_2022_PROGRAM;
  const mint = decodeMint(mintAccount.data);
  if (isToken2022) findings.push(TOKEN_2022_WARNING);
  if (mint.decimals !== wrapper.decimals) {
    findings.push({ level: "block", code: "decimals", message: `Decimals differ: the Base wrapper uses ${wrapper.decimals}, the Solana mint uses ${mint.decimals}.` });
  }

  // The vault address is derived exactly as the bridge program derives it, and the release dry run
  // moves tokens out of it, so anything wrong with the vault fails that dry run.
  if (!vaultAccount) {
    findings.push({ level: "block", code: "vault-missing", message: "The bridge has no vault for this token on Solana, so there is nothing to release it from." });
  }
  const vaultBalance = vaultAccount ? decodeTokenAccount(vaultAccount.data).amount : 0n;

  return {
    wrapper,
    kind: "spl",
    mint: { address: mintAddress, tokenProgram: mintAccount.owner, account: mint, isToken2022 },
    vault: { address: vaultAddress, balance: vaultBalance },
    findings
  };
}

export function parseAmount(input: string, decimals: number): bigint {
  const value = input.trim();
  if (!value) throw new UserFacingError("Enter an amount.");
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) throw new UserFacingError("Enter a plain number, like 1.5.");
  if ((match[2]?.length ?? 0) > decimals) throw new UserFacingError(`This token supports at most ${decimals} decimal places.`);
  const amount = parseUnits(value, decimals);
  if (amount <= 0n) throw new UserFacingError("The amount must be greater than zero.");
  if (amount > U64_MAX) throw new UserFacingError("The amount is larger than the bridge can carry in one transfer.");
  return amount;
}

export type Route = {
  /** Identifies exactly what was validated; any change to inputs produces a different key. */
  key: string;
  inspection: TokenInspection;
  amount: bigint;
  evmAccount: Address;
  recipientWallet: SolanaAddress;
  /** `to` in the Base transfer: the recipient's token account (SPL) or wallet (SOL). */
  destination: SolanaAddress;
  destinationExists: boolean;
  expectedReceived: bigint;
  findings: Finding[];
  transfer: { localToken: Address; remoteToken: Hex; to: Hex; remoteAmount: bigint };
};

export function routeKey(parts: { token: string; amount: string; evm: string; solana: string }): string {
  return [parts.token.trim().toLowerCase(), parts.amount.trim(), parts.evm.toLowerCase(), parts.solana].join("|");
}

export async function buildRoute(input: {
  inspection: TokenInspection;
  amountInput: string;
  evmAccount: Address;
  recipientWallet: SolanaAddress;
  base: PublicClient;
  rpc: SolanaRpc;
}): Promise<Route> {
  const { inspection, rpc } = input;
  const { wrapper } = inspection;
  const amount = parseAmount(input.amountInput, wrapper.decimals);
  const findings: Finding[] = [...inspection.findings];

  const balance = wrapper.balance ?? 0n;
  if (amount > balance) {
    findings.push({ level: "block", code: "balance", message: `Your Base wallet holds ${formatUnits(balance, wrapper.decimals)} ${wrapper.symbol}.` });
  }

  let destination: SolanaAddress;
  let destinationExists: boolean;
  let expectedReceived = amount;
  let destinationSpace = 0;
  let walletLamports = 0n;

  if (inspection.kind === "sol") {
    destination = input.recipientWallet;
    const [recipient] = await fetchAccounts(rpc, [destination]);
    destinationExists = Boolean(recipient);
    walletLamports = recipient?.lamports ?? 0n;
    const rentFloor = await fetchMinimumRent(rpc, 0);
    if (!recipient && amount < rentFloor) {
      findings.push({
        level: "block",
        code: "rent-floor",
        message: `Your Solana wallet is empty, so it must receive at least ${formatUnits(rentFloor, 9)} SOL for the account to exist. Increase the amount or fund the wallet first.`
      });
    }
    const remainder = inspection.vault.balance - amount;
    if (remainder < 0n) findings.push({ level: "block", code: "vault-balance", message: `The bridge's SOL vault holds ${formatUnits(inspection.vault.balance, 9)} SOL.` });
    else if (remainder > 0n && remainder < rentFloor) {
      findings.push({ level: "block", code: "vault-rent", message: "Releasing this amount would leave the SOL vault below Solana's minimum balance. Try a slightly different amount." });
    }
  } else {
    const mint = inspection.mint!;
    const [ata] = await findAssociatedTokenPda({ owner: input.recipientWallet, mint: mint.address, tokenProgram: mint.tokenProgram });
    destination = ata;
    const [account, wallet] = await fetchAccounts(rpc, [ata, input.recipientWallet]);
    destinationExists = Boolean(account);
    walletLamports = wallet?.lamports ?? 0n;
    if (amount > inspection.vault.balance) {
      findings.push({ level: "block", code: "vault-balance", message: `The bridge vault holds ${formatUnits(inspection.vault.balance, wrapper.decimals)} ${wrapper.symbol}.` });
    }
  }

  // Dry-run the release exactly as the claim will perform it. The token program decides; nothing is sent.
  if (!findings.some((finding) => finding.level === "block")) {
    const mint = inspection.mint;
    const rehearsal = inspection.kind === "sol" || !mint
      ? await rehearseRelease({ kind: "sol", rpc, amount, recipient: input.recipientWallet })
      : await rehearseRelease({
          kind: "spl",
          rpc,
          amount,
          mint: mint.address,
          decimals: mint.account.decimals,
          tokenProgram: mint.tokenProgram,
          vault: inspection.vault.address,
          destination,
          createForOwner: destinationExists ? null : input.recipientWallet
        });
    if (!rehearsal.ok) {
      findings.push({
        level: "block",
        code: "release-dry-run",
        message: `A dry run of the release from the bridge vault to your wallet fails right now (${rehearsal.reason}). Burning now would leave your tokens stuck in the bridge until that changes.`
      });
    } else {
      expectedReceived = rehearsal.received;
      if (!destinationExists && inspection.kind === "spl") destinationSpace = rehearsal.destinationSpace;
      if (rehearsal.received < amount) {
        findings.push({
          level: "warn",
          code: "release-shortfall",
          message: `The dry run shows you would receive ${formatUnits(rehearsal.received, wrapper.decimals)} ${wrapper.symbol}, not ${formatUnits(amount, wrapper.decimals)} — the token takes a fee on transfer.`
        });
      }
    }
  }

  // The claim is a separate Solana transaction paid in SOL: warn if the recipient wallet can't cover it.
  if (!findings.some((finding) => finding.level === "block")) {
    const claimCost =
      (await fetchMinimumRent(rpc, incomingMessageSpace(MESSAGE_LENGTH[inspection.kind]))) +
      (destinationSpace > 0 ? await fetchMinimumRent(rpc, destinationSpace) : 0n) +
      CLAIM_FEE_ALLOWANCE;
    if (walletLamports < claimCost) {
      findings.push({
        level: "warn",
        code: "claim-fee",
        message: `Your Solana wallet has ${formatUnits(walletLamports, 9)} SOL. Claiming on Solana costs about ${formatUnits(claimCost, 9)} SOL in fees and account rent, so add some SOL to it before you claim.`
      });
    }
  }

  const transfer = { localToken: wrapper.address, remoteToken: wrapper.remoteToken, to: addressToBytes32Hex(destination), remoteAmount: amount };

  // Dry-run the exact burn call from the user's address. Nothing is sent.
  if (!findings.some((finding) => finding.level === "block")) {
    try {
      await input.base.simulateContract({ address: NETWORK.base.bridge, abi: BRIDGE_ABI, functionName: "bridgeToken", args: [transfer, []], account: input.evmAccount, value: 0n });
    } catch (error) {
      findings.push({ level: "block", code: "simulation", message: `The burn would fail on Base: ${(error as { shortMessage?: string }).shortMessage ?? (error as Error).message}` });
    }
  }

  return {
    key: routeKey({ token: wrapper.address, amount: input.amountInput, evm: input.evmAccount, solana: input.recipientWallet }),
    inspection,
    amount,
    evmAccount: input.evmAccount,
    recipientWallet: input.recipientWallet,
    destination,
    destinationExists,
    expectedReceived,
    findings,
    transfer
  };
}
