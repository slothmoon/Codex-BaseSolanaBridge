/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BRIDGE_ENV?: string;
  readonly VITE_BASE_RPC_URL?: string;
  readonly VITE_BASE_ARCHIVE_RPC_URL?: string;
  readonly VITE_SOLANA_RPC_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
