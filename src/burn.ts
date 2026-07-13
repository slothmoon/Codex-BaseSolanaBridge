import { PublicKey } from "@solana/web3.js";
import {
  createWalletClient,
  custom,
  encodeFunctionData,
  formatUnits,
  getAddress,
  parseUnits,
  type Address,
  type Hex
} from "viem";

import { BRIDGE_ABI, CONFIG, ERC20_ABI, FACTORY_ABI } from "./config";
import { assertBridgeActive, isBurnValidationCurrent } from "./bridge-logic";
import {
  bytes32ToPubkey,
  deriveAta,
  getSolanaBridgeState,
  getTokenVaultPda,
  pubkeyToBytes32,
  readMintInfo,
  readVaultBalance
} from "./solana";
import { getBaseClient, solana, state, type ReturnDetails } from "./shared";
import { $, errorMessage, invalidateBurnValidation, rememberTx, renderDerived, setLinkedStatus, setStatus } from "./ui";
import { connectBase, connectSolana, ensureBaseNetwork } from "./wallets";

export async function previewReturn(): Promise<void> {
  invalidateBurnValidation();
  const details = await validateReturnDetails(true);
  renderDerived(details);
  state.validatedBurnKey = currentBurnValidationKey();
  const deriveButton = $<HTMLButtonElement>("deriveDetails");
  const burnButton = $<HTMLButtonElement>("burnButton");
  deriveButton.hidden = true;
  burnButton.hidden = false;
  burnButton.disabled = false;
  setStatus("All checks passed, including the official factory check. Review the destination and click Burn on Base.");
}

export async function startBridge(): Promise<void> {
  if (!state.evmAccount) await connectBase();
  if (!state.solanaAccount) await connectSolana();
  await ensureBaseNetwork();

  const validatedBurnKey = state.validatedBurnKey;
  if (!validatedBurnKey || validatedBurnKey !== currentBurnValidationKey()) {
    invalidateBurnValidation();
    throw new Error("Validate and preview the token and amount before burning.");
  }

  setStatus("Re-running all pre-burn checks...");
  const details = await validateReturnDetails(true);
  assertBurnInputsUnchanged(validatedBurnKey);
  if (!details.amount) throw new Error("Enter an amount greater than zero.");
  renderDerived(details);

  const transfer = {
    localToken: details.localToken,
    remoteToken: details.remoteToken,
    to: pubkeyToBytes32(details.recipientTokenAccount),
    remoteAmount: details.amount
  } as const;

  const baseClient = getBaseClient();
  setStatus("Simulating the Base burn. No transaction has been submitted yet...");
  try {
    await baseClient.simulateContract({
      address: CONFIG.baseBridge,
      abi: BRIDGE_ABI,
      functionName: "bridgeToken",
      args: [transfer, []],
      account: state.evmAccount as Address,
      value: 0n
    });
  } catch (error) {
    throw new Error(`Base simulation failed. Nothing was burned. ${errorMessage(error)}`);
  }
  assertBurnInputsUnchanged(validatedBurnKey);

  if (!window.ethereum) throw new Error("Base wallet disconnected.");
  const evmAccount = state.evmAccount;
  if (!evmAccount) throw new Error("Connect your Base wallet first.");
  const wallet = createWalletClient({
    chain: CONFIG.baseChain,
    transport: custom(window.ethereum),
    account: evmAccount
  });

  assertBurnInputsUnchanged(validatedBurnKey);
  setStatus("Confirm the burn transaction in your Base wallet.");
  // Consume validation before crossing the wallet submission boundary. A
  // provider can fail to return a hash even when submission may have occurred,
  // so every wallet outcome must require a fresh review before another burn.
  invalidateBurnValidation();
  let txHash: Hex;
  try {
    txHash = await wallet.sendTransaction({
      account: evmAccount,
      to: CONFIG.baseBridge,
      data: encodeFunctionData({
        abi: BRIDGE_ABI,
        functionName: "bridgeToken",
        args: [transfer, []]
      }),
      value: 0n
    });
  } catch (error) {
    throw new Error(formatBaseSubmissionFailure(error));
  }

  rememberTx(txHash);
  const baseExplorer = CONFIG.baseChain.blockExplorers?.default.url || "https://basescan.org";
  setLinkedStatus(
    `Burn submitted on Base:\n${txHash}\n\nKeep this hash. Return later and click Check status.`,
    "View on Base Explorer",
    `${baseExplorer}/tx/${txHash}`
  );
}

async function validateReturnDetails(requireAmount: boolean): Promise<ReturnDetails> {
  if (!state.evmAccount) await connectBase();
  if (!state.solanaAccount) await connectSolana();
  await ensureBaseNetwork();

  const evmAccount = state.evmAccount;
  if (!evmAccount) throw new Error("Connect your Base wallet first.");

  const baseClient = getBaseClient();
  const rawAddress = $<HTMLInputElement>("localToken").value.trim();
  const localToken = getAddress(rawAddress);
  const bytecode = await baseClient.getBytecode({ address: localToken });
  if (!bytecode || bytecode === "0x") throw new Error("No contract exists at that Base address.");

  setStatus("Checking the official factory and wrapper in one batched Base call...");
  const results = await baseClient.multicall({
    allowFailure: false,
    contracts: [
      { address: CONFIG.baseFactory, abi: FACTORY_ABI, functionName: "isCrossChainErc20", args: [localToken] },
      { address: localToken, abi: ERC20_ABI, functionName: "remoteToken" },
      { address: localToken, abi: ERC20_ABI, functionName: "decimals" },
      { address: localToken, abi: ERC20_ABI, functionName: "symbol" },
      { address: localToken, abi: ERC20_ABI, functionName: "bridge" },
      { address: localToken, abi: ERC20_ABI, functionName: "balanceOf", args: [evmAccount] }
    ]
  });
  const [official, remoteToken, decimals, symbol, wrapperBridge, wrapperBalance] = results as readonly [
    boolean, Hex, number, string, Address, bigint
  ];
  assertOfficialWrapper(official, localToken, wrapperBridge);

  const remoteMint = bytes32ToPubkey(remoteToken);
  setStatus("Checking the Solana bridge, mint, token program, decimals, ATA, and vault...");
  const [bridgeState, mintInfo] = await Promise.all([
    getSolanaBridgeState(solana, CONFIG.solanaBridgeProgram),
    readMintInfo(solana, remoteMint)
  ]);
  assertBridgeActive(bridgeState.paused);
  assertMatchingDecimals(Number(decimals), mintInfo.decimals);

  const solanaWallet = new PublicKey(state.solanaAccount);
  const recipientTokenAccount = deriveAta(solanaWallet, remoteMint, mintInfo.owner);
  const tokenVault = getTokenVaultPda(CONFIG.solanaBridgeProgram, remoteMint, localToken);
  const vaultBalance = await readVaultBalance(solana, tokenVault, remoteMint, mintInfo.owner);

  let amount: bigint | undefined;
  const amountInput = $<HTMLInputElement>("amount").value.trim();
  if (requireAmount || amountInput) {
    amount = validateBridgeAmount({
      amountInput,
      decimals: Number(decimals),
      symbol,
      wrapperBalance,
      vaultBalance
    });
  }

  return {
    localToken,
    symbol,
    decimals: Number(decimals),
    remoteToken,
    remoteMint,
    mintInfo,
    recipientTokenAccount,
    tokenVault,
    wrapperBalance,
    vaultBalance,
    amount
  };
}

function currentBurnValidationKey(): string {
  return [
    state.evmAccount.toLowerCase(),
    state.solanaAccount,
    $<HTMLInputElement>("localToken").value.trim().toLowerCase(),
    $<HTMLInputElement>("amount").value.trim()
  ].join("|");
}

export function assertOfficialWrapper(official: boolean, localToken: Address, wrapperBridge: Address): void {
  if (!official) {
    throw new Error(
      `Unsupported token: factory ${CONFIG.baseFactory} returned false for isCrossChainErc20(${localToken}). Nothing was submitted.`
    );
  }
  if (getAddress(wrapperBridge) !== getAddress(CONFIG.baseBridge)) {
    throw new Error("Unsupported wrapper: its authorized bridge is not the official bridge configured by this page.");
  }
}

export function assertMatchingDecimals(wrapperDecimals: number, mintDecimals: number): void {
  if (wrapperDecimals !== mintDecimals) {
    throw new Error(`Decimal mismatch: Base wrapper uses ${wrapperDecimals}, but the Solana mint uses ${mintDecimals}. Nothing was submitted.`);
  }
}

export function validateBridgeAmount(input: {
  amountInput: string;
  decimals: number;
  symbol: string;
  wrapperBalance: bigint;
  vaultBalance: bigint;
}): bigint {
  const { amountInput, decimals, symbol, wrapperBalance, vaultBalance } = input;
  if (!amountInput) throw new Error("Enter the amount to return.");
  const decimalMatch = amountInput.match(/^(?:\d+)(?:\.(\d+))?$/);
  if (!decimalMatch || (decimalMatch[1]?.length ?? 0) > decimals) {
    throw new Error(`Invalid amount. ${symbol} supports up to ${decimals} decimal places.`);
  }

  let amount: bigint;
  try {
    amount = parseUnits(amountInput, decimals);
  } catch {
    throw new Error(`Invalid amount. ${symbol} supports up to ${decimals} decimal places.`);
  }
  if (amount <= 0n) throw new Error("Amount must be greater than zero.");
  if (amount > 2n ** 64n - 1n) throw new Error("Amount is too large for the bridge's uint64 Solana amount.");
  if (amount > wrapperBalance) {
    throw new Error(`Insufficient Base balance. Wallet has ${formatUnits(wrapperBalance, decimals)} ${symbol}.`);
  }
  if (amount > vaultBalance) {
    throw new Error(`The Solana bridge vault has only ${formatUnits(vaultBalance, decimals)} ${symbol} available.`);
  }
  return amount;
}

export function formatBaseSubmissionFailure(error: unknown): string {
  const code = getNestedProviderErrorCode(error);
  if (code === 4001) {
    return "Base transaction rejected in the wallet. Nothing was submitted. Validate the route again when you are ready.";
  }
  return [
    "The Base wallet did not return a transaction hash, so submission could not be verified.",
    "Check your wallet activity before trying again. Do not burn again if the transaction appears there.",
    `Validate the route again only after confirming no burn was submitted. ${errorMessage(error)}`
  ].join("\n\n");
}

function getNestedProviderErrorCode(error: unknown): number | undefined {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if ("code" in current) {
      const code = Number((current as { code: unknown }).code);
      if (Number.isFinite(code)) return code;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function assertBurnInputsUnchanged(expectedKey: string): void {
  if (!isBurnValidationCurrent(expectedKey, state.validatedBurnKey, currentBurnValidationKey())) {
    invalidateBurnValidation();
    throw new Error("Wallet, network, token, or amount changed during validation. Review the updated route and validate again before burning.");
  }
}
