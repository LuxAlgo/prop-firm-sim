import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    // Let package tests import the workspace packages from source, so the
    // suite runs without a prior build. Subpath aliases must come first.
    alias: [
      {
        find: "@luxalgo/prop-firm-sim-core/directory",
        replacement: r("./packages/core/src/directory/index.ts"),
      },
      {
        find: "@luxalgo/prop-firm-sim-core",
        replacement: r("./packages/core/src/index.ts"),
      },
    ],
  },
  test: {
    include: ["packages/*/tests/**/*.test.ts"],
    environment: "node",
  },
});
