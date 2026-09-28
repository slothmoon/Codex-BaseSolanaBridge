import { defineConfig } from "vite";

export default defineConfig({
  oxc: {
    jsx: { runtime: "automatic", importSource: "preact" }
  },
  build: {
    target: "es2022",
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: "solana", test: /node_modules[\\/](@solana|@solana-program|@wallet-standard)/ },
            { name: "viem", test: /node_modules[\\/](viem|@noble|@scure|ox|abitype)/ },
            { name: "preact", test: /node_modules[\\/](preact|@preact)/ }
          ]
        }
      }
    }
  }
});
