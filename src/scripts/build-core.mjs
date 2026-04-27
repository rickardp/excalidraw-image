// src/scripts/build-core.mjs — J-010
//
// Bundles `src/core/index.mjs` (the `__render` entry, J-008) into a single
// ESM file `dist/core.mjs` that the Rust shell (R-series) embeds via
// `include_str!`. Also writes `dist/meta.json` for the J-011 forbidden-path
// audit.
//
// This is production tooling and runs under Node at build time — not under
// Deno or deno_core. It is therefore allowed to import `node:*` modules.
// See `eslint.config.js`: the host-neutrality rules apply to `src/core/**`,
// not `src/scripts/**`.
//
// Design is lifted verbatim from F-001's `spike/build.mjs`:
//
// - `platform: "neutral"` + explicit `mainFields` + `conditions` (default
//   `[]` breaks CJS resolution for `inherits`, `crc-32`, etc. See
//   `spike/README.md` §"Known weird things".)
// - Editor-only packages (react*, jotai*, mermaid, @radix-ui/*) are aliased
//   to the callable-Proxy stub at `src/core/stubs/proxy.mjs`. A plain `{}`
//   stub breaks `Object.assign(ImportedSymbol, {…})` and
//   `const { useAtom } = createIsolation()` destructuring. See the feasibility spike notes
//   §"Finding A".
// - `@radix-ui/*` wildcards go through a plugin (esbuild `alias` does not
//   support wildcards).
// - Excalidraw's static `import("./locales/xx-YY-HASH.js")` sites are
//   rewritten via a plugin to the same Proxy stub — saves ~1.7 MB.
// - `.css` files are swallowed by the `empty` loader.
// - `import.meta.*` references are replaced with string literals at build
//   time. the feasibility spike notes: `deno_core`'s classic-script `execute_script`
//   path doesn't expose `import.meta`, so the bundle must not contain any.

import { build } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const stubPath = path.join(repoRoot, "src/core/stubs/proxy.mjs");
const entry = path.join(repoRoot, "src/core/index.mjs");
const outfile = path.join(repoRoot, "dist/core.mjs");
const metafilePath = path.join(repoRoot, "dist/meta.json");
// Mirror copy used by `cargo publish` for the main crate. assets/core.mjs is
// .gitignored — we regenerate it on every `make core` so it can never go
// stale relative to dist/core.mjs. The main crate's build.rs falls back to
// this path when dist/core.mjs is missing (e.g., inside a published .crate
// tarball where dist/ doesn't ship).
const assetsMirror = path.join(
  repoRoot,
  "crates/excalidraw-image/assets/core.mjs",
);

const pkg = JSON.parse(
  readFileSync(path.join(repoRoot, "package.json"), "utf8"),
);

// Wildcard-stub plugin. Matches:
//   - @radix-ui/react-popover, @radix-ui/react-tabs, … (entire family)
//   - any dynamic `import("./locales/xx-YY-HASH.js")` in Excalidraw's index.
// Both route to src/core/stubs/proxy.mjs — a real on-disk module, not a
// virtual one, so stack traces are readable and the Rust build can ship the
// exact same file.
const radixPlugin = {
  name: "radix-stub",
  setup(b) {
    b.onResolve({ filter: /^@radix-ui\// }, () => ({ path: stubPath }));
  },
};

const localesPlugin = {
  name: "locales-stub",
  setup(b) {
    b.onResolve({ filter: /(^|\/)locales\/[a-zA-Z0-9_-]+\.js$/ }, () => ({
      path: stubPath,
    }));
  },
};

const result = await build({
  absWorkingDir: repoRoot,
  entryPoints: [entry],
  bundle: true,
  format: "esm",
  platform: "neutral",
  // `platform=neutral` defaults `mainFields` to `[]`, which breaks CJS
  // packages like `inherits` and `crc-32`. Restore a browser-ish resolution
  // so transitive deps resolve the same way Excalidraw expects.
  mainFields: ["browser", "module", "main"],
  conditions: ["module", "import", "browser", "default"],
  outfile,
  metafile: true,
  minify: true,
  treeShaking: true,
  legalComments: "none",
  // the implementation notes step 3: strip console + debugger from the shipped bundle.
  drop: ["console", "debugger"],
  alias: {
    react: stubPath,
    "react-dom": stubPath,
    "react-dom/client": stubPath,
    "react/jsx-runtime": stubPath,
    "react/jsx-dev-runtime": stubPath,
    jotai: stubPath,
    "jotai-scope": stubPath,
    "@excalidraw/mermaid-to-excalidraw": stubPath,
  },
  loader: { ".css": "empty" },
  plugins: [radixPlugin, localesPlugin],
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
    "import.meta.env.DEV": "false",
    "import.meta.env.PROD": "true",
    "import.meta.env.PKG_NAME": JSON.stringify(pkg.name),
    "import.meta.env.PKG_VERSION": JSON.stringify(pkg.version),
    // Bundled code evaluated by deno_core via classic-script execute_script
    // has no `import.meta.url`; stub to a harmless placeholder so lingering
    // references don't throw a SyntaxError. the feasibility spike notes.
    "import.meta.url": JSON.stringify("file:///core.mjs"),
  },
  logLevel: "info",
});

// Ensure dist/ exists, then write the metafile for J-011.
mkdirSync(path.dirname(metafilePath), { recursive: true });
writeFileSync(metafilePath, JSON.stringify(result.metafile, null, 2));

// Mirror dist/core.mjs into the main crate's assets/ so `cargo publish`
// has it available without needing make core to have run separately.
mkdirSync(path.dirname(assetsMirror), { recursive: true });
copyFileSync(outfile, assetsMirror);

const outKey = path.relative(repoRoot, outfile);
const bytes = result.metafile.outputs[outKey]?.bytes;
const warnings = result.warnings.length;

console.log(
  `[build-core] wrote dist/core.mjs (${bytes ?? "?"} bytes)` +
    (warnings ? ` with ${warnings} warnings` : ""),
);
console.log(
  `[build-core] mirrored to crates/excalidraw-image/assets/core.mjs`,
);
