// Flat config (ESLint >=9). Host-neutrality for src/core/ — see PLAN.md §2 and §4.
// The JS core must be runnable unchanged under Deno (dev) and deno_core (ship).
// Only src/core/dev.mjs may touch Deno.* — it is a Deno-only dev entry, not shipped.

import globals from "globals";

const HOST_GLOBALS = [
  {
    name: "Bun",
    message: "Bun.* is forbidden in src/core — the bundle must run under Deno and deno_core.",
  },
  {
    name: "Deno",
    message: "Deno.* is forbidden in src/core except in src/core/dev.mjs (the Deno-only dev entry).",
  },
  {
    name: "process",
    message: "process.* is forbidden in src/core — it is a Node/Bun-specific global.",
  },
  {
    name: "Buffer",
    message: "Buffer is forbidden in src/core — use Uint8Array / TextEncoder instead.",
  },
  {
    name: "require",
    message: "require() is forbidden in src/core — the bundle is ESM-only.",
  },
  {
    name: "__dirname",
    message: "__dirname is a Node CommonJS global and is forbidden in src/core.",
  },
  {
    name: "__filename",
    message: "__filename is a Node CommonJS global and is forbidden in src/core.",
  },
];

const HOST_IMPORT_PATTERNS = [
  {
    group: ["fs", "fs/*", "path", "path/*", "node:*", "bun:*"],
    message:
      "src/core must not import host modules (fs/path/node:*/bun:*). Bytes enter via JSON / embedded assets.",
  },
];

export default [
  // Base block: ES2022 modules for anything under src/.
  {
    files: ["src/**/*.{mjs,ts,mts}"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.es2022,
      },
    },
  },

  // Host-neutrality block: applies to src/core/** but NOT src/core/dev.mjs.
  {
    files: ["src/core/**/*.{mjs,ts,mts}"],
    ignores: ["src/core/dev.mjs"],
    rules: {
      "no-restricted-globals": ["error", ...HOST_GLOBALS],
      "no-restricted-imports": [
        "error",
        {
          patterns: HOST_IMPORT_PATTERNS,
        },
      ],
    },
  },
];
