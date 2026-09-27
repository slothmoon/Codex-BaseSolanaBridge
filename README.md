# Return to Solana — v2

A static, non-custodial web app for moving **Base-wrapped Solana assets back to Solana** through the official [Base–Solana bridge](https://docs.base.org/base-chain/quickstart/base-solana-bridge): SPL tokens (Standard and Token-2022) and native SOL.

There is no backend, database or relayer key. The browser reads public Base and Solana RPCs, checks the route, generates and **verifies** the proof locally, builds every transaction, and asks your wallets to sign.

## How a return works

1. **Burn on Base.** You burn the bridge wrapper with `Bridge.bridgeToken`. The destination is fixed at this point: your Solana wallet's token account (SPL) or your wallet itself (SOL).
2. **Wait for an output root.** Once the Base block containing your burn is finalized (~20 min) and an output root covering it is registered on Solana (roots sit at every 300th Base block), the message becomes provable.
3. **Claim on Solana.** Base → Solana has no automatic relay: someone must submit the claim. The app proves the message against that root (`prove_message`) and releases the funds (`relay_message`). Any wallet can pay for the claim and the funds always go to the recipient fixed at burn time — except an SPL return whose token account doesn't exist yet, which the recipient's own wallet must claim, because the account's owner can't be worked out from its address.

On recent mainnet returns, the covering root arrived 21–34 minutes after the burn.

Paste any burn transaction hash into **Track & claim** to see where it is. The hash is all you need to recover a claim, from any browser.

## Safety checks

Before the burn button is enabled, all of these must pass:

- The token was created by the Base bridge factory (`CrossChainERC20Factory`). Anyone can use that factory, so this proves the token is a real bridge wrapper, not which project it belongs to — the vault balance shows what this wrapper can actually release.
- Neither side of the bridge is paused.
- The Solana mint exists, uses SPL Token or Token-2022, and has the same decimals as the wrapper.
- The bridge vault exists and holds enough to release. For SOL, releasing the amount must also leave the vault rent-exempt, and an empty recipient wallet must receive at least Solana's minimum account balance.
- **The release is dry-run before you burn.** The app simulates exactly what the claim will do on Solana — create your token account if needed, then `transfer_checked` out of the bridge vault, signed by the vault itself (SOL: a transfer out of the SOL vault) — with signature checks off and the bridge's own SOL vault paying. The token program decides the outcome, so transfer hooks, pauses, frozen accounts, memo requirements, non-transferable mints and any future Token-2022 feature are covered without this app having to recognise them. The amount shown as "You receive" is what the dry run actually delivered, so transfer fees are measured, not estimated.
- The exact `bridgeToken` call succeeds in an `eth_call` simulation from your address.
- If your Solana wallet holds less SOL than the claim will cost (fees plus account rent), a warning says so. It doesn't block the burn: you can add SOL before claiming.

**Token-2022 tokens show a warning** (as in v1): their extensions can charge transfer fees, change the amount received, or prevent the Solana claim, so test with a small amount first and confirm it arrives before burning the rest.

The review is tied to a key made from every input (token, amount, both wallets). Change anything and the review is discarded; the route is re-validated again right before the wallet prompt.

## What's new in v2

| Area | v1 | v2 |
|---|---|---|
| Claim size | One legacy transaction; fails once a proof exceeds 17 nodes (common for late claims) | Standard v0 transactions: one when it fits, otherwise prove then release (up to 21 nodes). Only for claims made long after the burn on a busy bridge (22+ nodes) does it use one large v1 transaction, which needs a wallet that supports v1. Proofs are made against the latest output root, as in the official scripts, so they grow over time |
| Proof safety | Sent unchecked | Verified locally against the on-chain output root before any signature |
| Priority fees | None | 75th-percentile recent fee for the touched accounts, clamped; compute limit sized from simulation |
| Assets | SPL only | SPL, Token-2022 and native SOL; tracks and claims wrapped-token transfers too |
| Token safety | Token-2022 warning | A dry run of the exact vault release gates every burn and measures what you receive; Token-2022 keeps the v1 small-amount-first warning |
| Claim payer | Must be the recipient | Any wallet can pay (unless the recipient's token account must be created); the funds still go to the fixed recipient |
| Wallets | `window.ethereum` / `window.solana` | EIP-6963 (pick among installed EVM wallets) and Wallet Standard (Phantom, Solflare, Backpack, …) |
| Wallet check | Fee payer and signature present | Fee payer unchanged and the connected account's signature verifies |
| Ambiguous send failures | Warned | If the Base wallet errors without a clear rejection, the review is discarded so a second click can't burn twice |
| Interrupted claims | Restart | Clicking Claim again continues from on-chain state (e.g. only the release if the proof already landed) |
| RPC resilience | Single endpoint | Ordered fallbacks for Base and Solana; separate archive endpoint for proofs |
| Status | Manual refresh | Manual refresh (click Track), ETA from Base finality, clear reverted/not-found/not-a-bridge states, local history of your burns |
| Stack | Vanilla DOM, web3.js v1 | Preact + signals, `@solana/kit` (~1/4 the Solana bundle size), viem |

## Development

```bash
npm install
npm run dev
```

| Command | What it does |
|---|---|
| `npm test` | Offline unit tests (IDL parity, real mainnet payloads/proofs/accounts, planner, executor, UI) |
| `npm run test:svm` | Runs the claim transactions against the **real mainnet program binary** in LiteSVM, with accounts cloned from mainnet (Linux/macOS; needs network; also runs in CI) |
| `npm run test:live` | Optional, manual, read-only mainnet checks: real wrappers, proof verification, release dry runs, and simulated relays |
| `npm run typecheck` / `npm run build` | Strict TypeScript / production bundle |

`tests/fixtures/bridge.idl.json` is the official program IDL (commit in `bridge.idl.commit`). `tests/fixtures/mainnet.json` is a snapshot of real mainnet data; regenerate it with `CAPTURE_FIXTURES=1 npx vitest run --project live capture-fixtures`.

## Configuration

Copy `.env.example` to `.env`. Every `VITE_` variable is public in the bundle — never put secrets there.

- `VITE_BASE_RPC_URL`, `VITE_SOLANA_RPC_URL` — preferred endpoints, tried before the public defaults.
- `VITE_BASE_ARCHIVE_RPC_URL` — archive-capable Base endpoint for historical `eth_call` (proofs). High-traffic deployments should set domain-restricted endpoints.

If Base announces a bridge upgrade, follow their instructions and run `npm run test:live` to confirm this app still works against it.

## Deploy (Vercel)

Import the repository, use the **Vite** preset, build command `npm run build`, output `dist`. `vercel.json` sets a strict CSP (no inline scripts or styles, `connect-src` https only) and immutable caching for hashed assets. No server functions or secrets are needed.

## Scope and limits

- Returns only Base-wrapped Solana assets created by the Base bridge factory. It does not bridge Base-native ERC-20s or ETH to Solana, and does not attach follow-up Solana instructions.
- Transfers that carry extra Solana instructions, or cross-chain calls, are tracked but not claimed here.
- The claim fee payer needs a little SOL for fees and rent: the proof account, plus the token account if it doesn't exist.
- Not affiliated with Base or Coinbase. Use at your own risk.
