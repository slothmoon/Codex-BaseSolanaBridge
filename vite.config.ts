import { defineConfig } from "vite";

export default defineConfig({
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("@solana") || id.includes("rpc-websockets") || id.includes("borsh")) return "solana";
          if (id.includes("viem") || id.includes("@noble")) return "viem";
          if (id.includes("buffer") || id.includes("base64-js") || id.includes("ieee754")) return "buffer";
          return undefined;
        }
      }
    }
  }
});
