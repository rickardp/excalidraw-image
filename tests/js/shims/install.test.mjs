// Unit tests for src/core/shims/install.mjs (J-007).
//
// The install module is side-effect-only: importing it runs every shim in
// the canonical order (dom → web-globals → fonts → fetch-fonts → canvas →
// workers). Each shim owns its own idempotency; we only assert here that
// composition works end-to-end and that importing twice is a no-op.
//
// NOTE: because vitest may run other shim tests in the same worker, we
// cannot reliably assert the "pre-install" state of globals — sibling tests
// in the same process may have already installed parts of the surface.
// Per the task prompt, we keep this test simple: import once and assert
// every signature global is present afterwards.

import { describe, it, expect } from "vitest";

describe("shims/install.mjs", () => {
  it("installs every shim on first import and leaves all signature globals present", async () => {
    await import("../../../src/core/shims/install.mjs");

    // dom: linkedom window + document must be live.
    expect(globalThis.document).toBeDefined();
    expect(globalThis.window).toBeDefined();

    // dom (Finding C): devicePixelRatio wired for the renderer chunk.
    expect(typeof globalThis.devicePixelRatio).toBe("number");

    // web-globals: URL is callable (may be host-native or polyfilled).
    expect(typeof globalThis.URL).toBe("function");

    // fonts: FontFace constructor is installed.
    expect(typeof globalThis.FontFace).toBe("function");

    // fetch-fonts: fetch is wrapped (callable).
    expect(typeof globalThis.fetch).toBe("function");

    // canvas: document.createElement("canvas").getContext exists.
    const canvas = globalThis.document.createElement("canvas");
    expect(typeof canvas.getContext).toBe("function");

    // workers: Worker must be absent before the Excalidraw bundle evaluates.
    expect(typeof globalThis.Worker).toBe("undefined");
  });

  it("is a no-op on second import (ES module cache + per-shim idempotency)", async () => {
    // Re-importing the same specifier hits the ESM cache and does not re-run
    // the installers. Either way, the call must not throw and the globals
    // must still be present.
    await expect(
      import("../../../src/core/shims/install.mjs"),
    ).resolves.toBeDefined();

    expect(globalThis.document).toBeDefined();
    expect(typeof globalThis.FontFace).toBe("function");
    expect(typeof globalThis.fetch).toBe("function");
    expect(typeof globalThis.Worker).toBe("undefined");
  });
});
