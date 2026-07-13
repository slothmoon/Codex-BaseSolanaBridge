# Base -> Solana SPL Return Bridge

A fully static, non-custodial web interface for users returning official Base-wrapped SPL tokens to their original Solana mint.

There is no backend, database, relayer key, or server process. The browser reads Base and Solana RPC endpoints, validates the route, generates the MMR proof, constructs the Solana transaction, and asks the user's wallets to sign.

## What users provide

- A connected Base wallet to validate and submit the burn
- A connected Solana wallet for the destination and claim
- The official Base wrapped-SPL token address
- The amount to return

The page automatically discovers the original SPL mint, detects Standard SPL Token or Token-2022, derives the destination ATA, and creates the ATA idempotently during the claim when needed.

## Safety checks before the Base burn

The page refuses to submit unless:

- The Base address contains contract code
- The official CrossChainERC20Factory returns `true` from `isCrossChainErc20(wrapper)`
- The wrapper authorizes the configured official Base bridge
- The configured Solana bridge is not paused
- The remote Solana mint exists
- The mint is owned by Standard SPL Token or Token-2022
- Base wrapper decimals match Solana mint decimals
- The derived bridge vault exists and matches the mint and token program
- The user's Base balance and bridge-vault balance cover the amount
- `Bridge.bridgeToken(...)` succeeds in an `eth_call` simulation

For Token-2022 mints, the page detects the Token-2022 program owner and shows a warning to try a small amount first. Support can vary by token behavior and bridge-program behavior, so the UI does not claim every Token-2022 token is fully supported.

The **Burn on Base** button remains disabled until all checks pass. Changing the wrapper address, amount, Base wallet, or Solana wallet invalidates validation and disables the button again.

The Base transaction hash is saved to browser local storage. Users can also paste any prior burn transaction hash manually.
Status checks and Solana claims do not require a connected Base wallet; the configured public Base RPC provides the read-only proof data needed for recovery.

## Local development

```bash
npm install
npm run dev
```

For testnet, copy `.env.example` to `.env` and set:

```bash
VITE_BRIDGE_ENV=testnet
```

## Deploy to Vercel

1. In Vercel, import the GitHub repository.
2. Use the production branch `main`.
3. Framework preset: **Vite**.
4. Build command: `npm run build`.
5. Build output directory: `dist`.
6. No serverless functions, database, or secret runtime variables are required.
7. Deploy.

Vercel will build and redeploy the static site whenever `main` is pushed.

Optional build variables:

- `VITE_BRIDGE_ENV=mainnet` or `testnet`
- `VITE_BASE_RPC_URL=<browser-compatible Base RPC>`
- `VITE_SOLANA_RPC_URL=<browser-compatible Solana RPC>`

Anything beginning with `VITE_` is public in the browser bundle. Never put a secret or unrestricted paid RPC key there.

This package includes `.env.production` with:

```bash
VITE_BASE_RPC_URL=https://mainnet.base.org
VITE_SOLANA_RPC_URL=https://solana-rpc.publicnode.com
```

These endpoints are compiled into the production `dist` bundle. No Vercel runtime variables are needed unless you want to override them.

## Important operational notes

- Base -> Solana is not instant. The user must wait until validators register a sufficiently recent output root on Solana.
- After the Solana RPC accepts a claim, the page shows the transaction signature immediately. This means submitted, not finalized; **Check status** reads the bridge account for the authoritative claim outcome.
- The user's Solana wallet pays transaction fees and rent for the per-message proof account, and possibly the ATA. Keep a small SOL buffer available; Token-2022 ATAs may need more rent than ordinary SPL accounts.
- The bundled Base RPC `https://mainnet.base.org` supports the historical `eth_call` required for proof recovery, but it is rate limited. The page first tries the connected Base wallet RPC, then the configured `VITE_BASE_RPC_URL`. Higher-traffic deployments should configure a browser-compatible archive RPC, preferably with domain restrictions; an override without historical state support cannot generate claims from older output roots.
- The site is intentionally limited to returning official Base-wrapped SPL tokens. It does not support Base-native ERC-20s, ETH, SOL wrappers, arbitrary follow-up instructions, or subsidized relaying.
