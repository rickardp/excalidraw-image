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
  },
});
