import { defineConfig } from "vitest/config";

export default defineConfig({
  oxc: {
    jsx: { runtime: "automatic", importSource: "preact" }
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.{ts,tsx}"],
          environment: "happy-dom"
        }
      },
      {
        // Runs the real mainnet bridge program in LiteSVM (Linux/macOS only; skipped elsewhere).
        extends: true,
        test: {
          name: "svm",
          include: ["tests/svm/**/*.test.ts"],
          environment: "node",
          testTimeout: 180_000,
          hookTimeout: 180_000
        }
      },
      {
        // Read-only checks against live mainnet RPCs. Opt-in: `npm run test:live`.
        extends: true,
        test: {
          name: "live",
          include: ["tests/live/**/*.test.ts"],
          environment: "node",
          testTimeout: 180_000,
          retry: 1
        }
      }
    ]
  }
});
