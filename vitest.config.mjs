import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/js/**/*.test.mjs"],
    exclude: [
      "tests/deno/**",
      "node_modules/**",
      "dist/**",
      "target/**",
      "reference/**",
      "spike/**",
      "spike-rust/**",
    ],
    // 20 MB dist/core.mjs + font subsetting on first import occasionally
    // trips the default 5s timeout under concurrent load.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
