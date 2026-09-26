# Return to Solana — v2

A static, non-custodial web app for moving **Base-wrapped Solana assets back to Solana** through the official [Base–Solana bridge](https://docs.base.org/base-chain/quickstart/base-solana-bridge): SPL tokens (Standard and Token-2022) and native SOL.

There is no backend, database or relayer key. The browser reads public Base and Solana RPCs, checks the route, generates and **verifies** the proof locally, builds every transaction, and asks your wallets to sign.

## How a return works

1. **Burn on Base.** You burn the official wrapper with `Bridge.bridgeToken`. The destination is fixed at this point: your Solana wallet's token account (SPL) or your wallet itself (SOL).
2. **Wait for an output root.** Once the Base block containing your burn is finalized (~20 min) and an output root covering it is registered on Solana (roots sit at every 300th Base block), the message becomes provable.
3. **Claim on Solana.** Base → Solana has no automatic relay: someone must submit the claim. The app proves the message against that root (`prove_message`) and releases the funds (`relay_message`). Any wallet can pay for the claim; the funds always go to the recipient fixed at burn time.

On recent mainnet returns, the covering root arrived 21–34 minutes after the burn.

Paste any burn transaction hash into **Track & claim** to see where it is. The hash is all you need to recover a claim, from any browser.

## Safety checks

Before the burn button is enabled, all of these must pass:

- The token is from the official `CrossChainERC20Factory` and is bound to the official Base bridge.
- Neither side of the bridge is paused.
- The Solana mint exists, uses SPL Token or Token-2022, and has the same decimals as the wrapper.
- The bridge vault exists, matches the mint, isn't frozen, and holds enough to release. For SOL, releasing the amount must also leave the vault rent-exempt.
- **Token-2022 features are inspected.** The app blocks mints whose claim would fail after your burn: a transfer hook, non-transferable, paused, or new accounts frozen by default. It warns about transfer fees (and shows what you'll actually receive), permanent delegates, and UI amount scaling.
- Your existing destination account isn't frozen and doesn't require incoming-transfer memos.
- For SOL, an empty recipient wallet gets at least Solana's minimum account balance.
- The exact `bridgeToken` call succeeds in an `eth_call` simulation from your address.

The review is tied to a key made from every input (token, amount, both wallets). Change anything and the review is discarded; the route is re-validated again right before the wallet prompt.

## What's new in v2

| Area | v1 | v2 |
|---|---|---|
| Claim size | One legacy transaction; fails once a proof exceeds 17 nodes (common for late claims) | One 4 KB v1 transaction when the wallet supports it; otherwise a prove/release split, or the official buffered prove path for any proof size |
| Proof safety | Sent unchecked | Verified locally against the on-chain output root before any signature |
| Priority fees | None | 75th-percentile recent fee for the touched accounts, clamped; compute limit sized from simulation |
| Assets | SPL only | SPL, Token-2022 (with extension checks) and native SOL; tracks and claims wrapped-token transfers too |
| Claim payer | Must be the recipient | Any wallet can pay; the funds still go to the fixed recipient |
| Wallets | `window.ethereum` / `window.solana` | EIP-6963 (pick among installed EVM wallets) and Wallet Standard (Phantom, Solflare, Backpack, …) |
| Wallet tampering | Checked fee payer only | Verifies the payer signature, and that every bridge instruction is still present byte-for-byte if the wallet edited the transaction |
| Interrupted claims | Restart | Resumes from on-chain state (including a half-uploaded proof buffer); leftover buffers are closed for their rent |
| RPC resilience | Single endpoint | Ordered fallbacks for Base and Solana; separate archive endpoint for proofs |
| Status | Manual refresh | Auto-polling, ETA from Base finality, clear reverted/not-found/not-a-bridge states, local history of your burns |
| Upgrades | Silent | Warns if the Base contracts or Solana program changed since this interface was verified |
| Stack | Vanilla DOM, web3.js v1 | Preact + signals, `@solana/kit` (~1/4 the Solana bundle size), viem |

## Development

```bash
npm install
npm run dev
```

| Command | What it does |
|---|---|
| `npm test` | Offline unit tests (IDL parity, real mainnet payloads/proofs/accounts, planner, executor, UI) |
| `npm run test:svm` | Runs every claim strategy against the **real mainnet program binary** in LiteSVM, with accounts cloned from mainnet (Linux/macOS; needs network) |
| `npm run test:live` | Read-only mainnet checks: deployment pins, real wrappers, proof verification, and simulations of real relays and buffer instructions |
| `npm run typecheck` / `npm run build` | Strict TypeScript / production bundle |

`tests/fixtures/bridge.idl.json` is the official program IDL (commit in `bridge.idl.commit`). `tests/fixtures/mainnet.json` is a snapshot of real mainnet data; regenerate it with `CAPTURE_FIXTURES=1 npx vitest run --project live capture-fixtures`.

## Configuration

Copy `.env.example` to `.env`. Every `VITE_` variable is public in the bundle — never put secrets there.

- `VITE_BRIDGE_ENV` — `mainnet` (default) or `testnet` (Base Sepolia → Solana devnet).
- `VITE_BASE_RPC_URL`, `VITE_SOLANA_RPC_URL` — preferred endpoints, tried before the public defaults.
- `VITE_BASE_ARCHIVE_RPC_URL` — archive-capable Base endpoint for historical `eth_call` (proofs). High-traffic deployments should set domain-restricted endpoints.

When the bridge is upgraded, re-verify and update `NETWORK.pins` in `src/config.ts` (the daily CI `live` job fails when they drift).

## Deploy (Vercel)

Import the repository, use the **Vite** preset, build command `npm run build`, output `dist`. `vercel.json` sets a strict CSP (no inline scripts or styles, `connect-src` https only) and immutable caching for hashed assets. No server functions or secrets are needed.

## Scope and limits

- Returns only official Base-wrapped Solana assets. It does not bridge Base-native ERC-20s or ETH to Solana, and does not attach follow-up Solana instructions.
- Transfers that carry extra Solana instructions, or cross-chain calls, are tracked but not claimed here.
- The claim fee payer needs a little SOL for fees and rent: the proof account, plus the token account if it doesn't exist. A proof buffer deposit, if used, is refunded.
- Not affiliated with Base or Coinbase. Use at your own risk.
