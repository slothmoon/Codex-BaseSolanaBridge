# Base → Solana SPL Return Bridge

A fully static, non-custodial web interface for users returning official Base-wrapped SPL tokens to their original Solana mint.

There is no backend, database, relayer key, or server process. The browser reads Base and Solana RPC endpoints, validates the route, generates the MMR proof, constructs the Solana transaction, and asks the user's wallets to sign.

## What users provide

- A connected Base wallet
- A connected Solana wallet
- The official Base wrapped-SPL token address
- The amount to return

The page automatically discovers the original SPL mint, detects Standard SPL Token or Token-2022, derives the destination ATA, and creates the ATA idempotently during the claim when needed.

## Safety checks before the Base burn

The page refuses to submit unless:

- The Base address contains contract code
- The official CrossChainERC20Factory returns `true` from `isCrossChainErc20(wrapper)`
- The wrapper authorizes the configured official Base bridge
- The remote Solana mint exists
- The mint is owned by Standard SPL Token or Token-2022
- Base wrapper decimals match Solana mint decimals
- The derived bridge vault exists and matches the mint and token program
- The user's Base balance and bridge-vault balance cover the amount
- `Bridge.bridgeToken(...)` succeeds in an `eth_call` simulation

The **Burn on Base** button remains disabled until all checks pass. Changing the wrapper address, amount, Base wallet, or Solana wallet invalidates validation and disables the button again.

The Base transaction hash is saved to browser local storage and added to the URL as `?tx=0x...`. Users can also paste any prior burn transaction hash manually.

## Local development

```bash
npm install
npm run dev
```

For testnet, copy `.env.example` to `.env` and set:

```bash
VITE_BRIDGE_ENV=testnet
```

## Deploy to Cloudflare Pages

1. In Cloudflare, open **Workers & Pages** and create a Pages project from this GitHub repository.
2. Use the production branch `main`.
3. Framework preset: **Vite**.
4. Build command: `npm run build`.
5. Build output directory: `dist`.
6. No D1, R2, Functions, secrets, or runtime variables are required.
7. Deploy.

Cloudflare will provide a free URL such as `https://basesolanabridge.pages.dev` if that project name is available.

Optional build variables:

- `VITE_BRIDGE_ENV=mainnet` or `testnet`
- `VITE_BASE_RPC_URLS=<primary URL,backup URL>` recommended
- `VITE_BASE_RPC_URL=<single browser-compatible Base RPC>` also supported
- `VITE_SOLANA_RPC_URL=<browser-compatible Solana RPC>`

Anything beginning with `VITE_` is public in the browser bundle. Never put a secret or unrestricted paid RPC key there.

This package includes `.env.production` with:

```bash
VITE_BASE_RPC_URLS=https://base-rpc.publicnode.com
VITE_SOLANA_RPC_URL=https://solana-rpc.publicnode.com
```

These endpoints are compiled into the production `dist` bundle. No Cloudflare runtime variables are needed.

## Important operational notes

- Base → Solana is not instant. The user must wait until validators register a sufficiently recent output root on Solana.
- The user's Solana wallet pays transaction fees and rent for the per-message proof account, and possibly the ATA. Keeping about `0.005 SOL` available is recommended.
- The default Base public RPC is rate limited and not intended for production. The page first tries the connected Base wallet RPC, then configured `VITE_BASE_RPC_URLS` fallbacks. For production, configure at least one browser-compatible provider URL, preferably with domain restrictions.
- The site is intentionally limited to returning official Base-wrapped SPL tokens. It does not support Base-native ERC-20s, ETH, SOL wrappers, arbitrary follow-up instructions, or subsidized relaying.
