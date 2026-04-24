// tests/js/bundle-smoke.test.mjs — J-012 complementary
//
// Weak smoke gate that runs under vitest (Node): verifies that a built
// `dist/core.mjs` exists and is plausibly-sized. This is NOT a runtime
// test — the real end-to-end pipeline check lives in
// tests/deno/render.test.mjs, which imports the bundle and calls
// `__render`. This file's purpose is to fail fast when someone runs
// `npm test` (or `make test`) without having built the bundle first
// (`make core`). The >10 MB floor matches the reality that the bundle
// inlines Excalidraw's font assets (~17.5 MB of base64 WOFF2), so a
// truncated or empty dist would be caught immediately.
//
// Why not import the bundle and render here? Because vitest runs under
// Node, and the bundle is built with esbuild `--platform=neutral` plus
// several host assumptions (Deno's `fetch`, `location`, etc.); running
// it under plain Node is not supported and has no parity guarantees.

import { describe, it, expect } from "vitest";
import { existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const bundlePath = resolve(here, "..", "..", "dist", "core.mjs");

describe("dist/core.mjs bundle sanity (J-012)", () => {
  it("exists on disk (run `make core` if this fails)", () => {
    expect(existsSync(bundlePath)).toBe(true);
  });

  it("is larger than 10 MB (base64 fonts inlined; empty or stub builds fail here)", () => {
    const size = statSync(bundlePath).size;
    // 10 MB floor — tight enough to catch stubs/truncated builds,
    // loose enough to allow esbuild output variation between runs.
    expect(size).toBeGreaterThan(10 * 1024 * 1024);
  });
});
