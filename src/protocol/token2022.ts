import { ByteReader, bytesToAddress } from "./bytes";
import type { MintAccount, TokenAccount, TokenExtensions } from "./accounts";

// Extension type numbers from @solana-program/token-2022 `ExtensionType` (verified against v0.19.0).
export const Ext = {
  TransferFeeConfig: 1,
  TransferFeeAmount: 2,
  MintCloseAuthority: 3,
  ConfidentialTransferMint: 4,
  DefaultAccountState: 6,
  ImmutableOwner: 7,
  MemoTransfer: 8,
  NonTransferable: 9,
  InterestBearingConfig: 10,
  CpiGuard: 11,
  PermanentDelegate: 12,
  NonTransferableAccount: 13,
  TransferHook: 14,
  TransferHookAccount: 15,
  ScaledUiAmountConfig: 25,
  PausableConfig: 26,
  PausableAccount: 27
} as const;

export type Finding = { level: "block" | "warn"; code: string; message: string };

export type TransferFee = { basisPoints: number; maximumFee: bigint; epoch: bigint };

function isZero(bytes: Uint8Array): boolean {
  return bytes.every((byte) => byte === 0);
}

export function readTransferFees(extensions: TokenExtensions): { older: TransferFee; newer: TransferFee } | null {
  const value = extensions.get(Ext.TransferFeeConfig);
  if (!value) return null;
  const reader = new ByteReader(value, "transfer fee config");
  reader.skip(32 + 32 + 8);
  const read = (): TransferFee => {
    const epoch = reader.u64();
    const maximumFee = reader.u64();
    return { epoch, maximumFee, basisPoints: reader.u16() };
  };
  const older = read();
  return { older, newer: read() };
}

/** The fee `transfer_checked` withholds when the vault releases `amount`. */
export function transferFeeFor(amount: bigint, extensions: TokenExtensions, currentEpoch: bigint | null): bigint {
  const fees = readTransferFees(extensions);
  if (!fees) return 0n;
  const active = currentEpoch !== null && currentEpoch >= fees.newer.epoch ? fees.newer : fees.older;
  const worst = currentEpoch === null
    ? (fees.newer.basisPoints >= fees.older.basisPoints ? fees.newer : fees.older)
    : active;
  if (worst.basisPoints === 0 || amount === 0n) return 0n;
  const raw = (amount * BigInt(worst.basisPoints) + 9_999n) / 10_000n; // ceil, as the program does
  return raw > worst.maximumFee ? worst.maximumFee : raw;
}

/**
 * Checks a returning SPL mint for Token-2022 features that make the Solana claim fail or pay out less
 * than expected. The bridge's relay only passes [mint, vault, destination, token program] to
 * `transfer_checked`, so anything that needs extra accounts or a memo cannot succeed.
 */
export function assessMint(mint: MintAccount, isToken2022: boolean): Finding[] {
  const findings: Finding[] = [];
  if (!mint.isInitialized) findings.push({ level: "block", code: "mint-uninitialized", message: "The Solana mint is not initialized." });
  if (!isToken2022) return findings;

  const ext = mint.extensions;
  const hook = ext.get(Ext.TransferHook);
  if (hook && !isZero(hook.subarray(32, 64))) {
    findings.push({
      level: "block",
      code: "transfer-hook",
      message: `This token runs a transfer hook (${bytesToAddress(hook.subarray(32, 64))}). The bridge relay cannot pass the hook's extra accounts, so the Solana claim would fail after your tokens are burned.`
    });
  }
  if (ext.has(Ext.NonTransferable)) {
    findings.push({ level: "block", code: "non-transferable", message: "This token is non-transferable, so the bridge vault cannot release it." });
  }
  const pausable = ext.get(Ext.PausableConfig);
  if (pausable && pausable.length >= 33) {
    if (pausable[32] === 1) findings.push({ level: "block", code: "paused", message: "The token issuer has paused all transfers of this token. Claims would fail right now." });
    else findings.push({ level: "warn", code: "pausable", message: "The token issuer can pause transfers. If they do before you claim, the claim waits until they unpause." });
  }
  const defaultState = ext.get(Ext.DefaultAccountState);
  if (defaultState && defaultState[0] === 2) {
    findings.push({
      level: "block",
      code: "default-frozen",
      message: "New token accounts for this mint start frozen, so a newly created destination account could not receive the claim. Use a wallet whose token account for this mint is already unfrozen."
    });
  }
  if (ext.has(Ext.TransferFeeConfig)) {
    const fees = readTransferFees(ext)!;
    const bps = Math.max(fees.older.basisPoints, fees.newer.basisPoints);
    if (bps > 0) {
      findings.push({ level: "warn", code: "transfer-fee", message: `The token charges a transfer fee of up to ${(bps / 100).toFixed(2)}%. You receive the amount minus that fee.` });
    }
  }
  const delegate = ext.get(Ext.PermanentDelegate);
  if (delegate && !isZero(delegate)) {
    findings.push({ level: "warn", code: "permanent-delegate", message: `The token has a permanent delegate (${bytesToAddress(delegate)}) that can move tokens out of any account, including the bridge vault.` });
  }
  if (ext.has(Ext.ScaledUiAmountConfig) || ext.has(Ext.InterestBearingConfig)) {
    findings.push({ level: "warn", code: "ui-scaling", message: "Wallets show a scaled amount for this token. The bridge moves raw token units, so displayed balances may differ." });
  }
  return findings;
}

/** Checks an existing destination token account. */
export function assessDestination(account: TokenAccount): Finding[] {
  const findings: Finding[] = [];
  if (account.state === "frozen") findings.push({ level: "block", code: "destination-frozen", message: "Your destination token account is frozen and cannot receive the claim." });
  const memo = account.extensions.get(Ext.MemoTransfer);
  if (memo && memo[0] === 1) {
    findings.push({ level: "block", code: "memo-required", message: "Your destination token account requires a memo on incoming transfers, which the bridge relay does not send." });
  }
  return findings;
}

export function assessVault(account: TokenAccount): Finding[] {
  return account.state === "frozen"
    ? [{ level: "block", code: "vault-frozen", message: "The bridge vault for this token is frozen, so it cannot release tokens." }]
    : [];
}

/**
 * Size of the associated token account the claim would create. Token-2022 ATAs always carry
 * ImmutableOwner plus the account-side extension required by each mint extension.
 */
export function associatedAccountSize(mintExtensions: TokenExtensions, isToken2022: boolean): number {
  if (!isToken2022) return 165;
  let size = 165 + 1 + 4; // account type + ImmutableOwner TLV header (empty value)
  if (mintExtensions.has(Ext.TransferFeeConfig)) size += 4 + 8;
  if (mintExtensions.has(Ext.NonTransferable)) size += 4;
  if (mintExtensions.has(Ext.TransferHook)) size += 4 + 1;
  if (mintExtensions.has(Ext.PausableConfig)) size += 4;
  return size;
}
