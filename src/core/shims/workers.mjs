// src/core/shims/workers.mjs
//
// Task J-006. Smallest shim in the series. Ensures `globalThis.Worker` is
// `undefined` so that Excalidraw's `packages/excalidraw/subset/subset-main.ts`
// captures `shouldUseWorkers = typeof Worker !== "undefined"` as `false` at
// module evaluation time and runs subsetting in-process.
//
// See the implementation notes and upstream SVG_EXPORT.md §3.4 for the rationale.
//
// Host-neutral: `deno_core` does not define `Worker`, so this shim is a no-op
// under the shipping host. Deno (dev) DOES define `Worker`, so the dev-loop
// parity with the shipping host depends on this shim running BEFORE the
// Excalidraw bundle is evaluated. J-007's install.mjs orders this correctly.
//
// Idempotent. Named export only; no top-level side effects.

let installed = false;

export function installWorkersShim() {
  if (installed) return;
  installed = true;
  // If a host (Deno, browsers, etc.) defined Worker, clear it. `deno_core`
  // does not set one, so this branch is a no-op under the shipping host.
  if (typeof globalThis.Worker !== "undefined") {
    try {
      delete globalThis.Worker;
    } catch {
      globalThis.Worker = undefined;
    }
  }
}
