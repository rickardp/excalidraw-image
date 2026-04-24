// Unit tests for src/core/index.mjs (J-008).
//
// Scope: verify the module registers `globalThis.__render`, that shims are
// installed as an import-time side effect, and that `__render(...)` returns
// a Promise. We deliberately do NOT call `__render` on a real scene in this
// file — Excalidraw's package root won't load under plain Node (the
// esbuild aliases that stub React/Jotai/Radix/CSS at BUNDLE time have not
// run here). End-to-end rendering is covered by the bundled smoke test in
// J-012 under Deno.

import { describe, it, expect } from "vitest";

describe("src/core/index.mjs (__render entry)", () => {
  it("registers globalThis.__render as a function on import", async () => {
    await import("../../src/core/index.mjs");

    expect(typeof globalThis.__render).toBe("function");
  });

  it("installs shims as an import-time side effect (install.mjs chain)", async () => {
    await import("../../src/core/index.mjs");

    // dom shim: linkedom window/document are live + devicePixelRatio wired.
    expect(typeof globalThis.document).not.toBe("undefined");
    expect(typeof globalThis.window).not.toBe("undefined");
    expect(typeof globalThis.devicePixelRatio).toBe("number");

    // fonts shim: FontFace constructor is installed.
    expect(typeof globalThis.FontFace).toBe("function");

    // fetch-fonts shim: fetch is wrapped.
    expect(typeof globalThis.fetch).toBe("function");

    // workers shim: Worker is absent before the bundle evaluates.
    expect(typeof globalThis.Worker).toBe("undefined");
  });

  it("globalThis.__render(...) returns a Promise", async () => {
    await import("../../src/core/index.mjs");

    // We pass a minimal object. The returned value is a Promise; it will
    // reject when it tries to dynamic-import @excalidraw/excalidraw under
    // Node (no esbuild aliases), which is expected and out of scope here.
    // We only care that the synchronous return shape is thenable.
    const result = globalThis.__render({ elements: [], appState: {} });
    expect(typeof result.then).toBe("function");

    // Swallow the expected rejection so vitest doesn't flag it.
    await result.catch(() => {});
  });

  it("tolerates both object and string optsJson (R-003 call shape)", async () => {
    await import("../../src/core/index.mjs");

    // Rust host (R-003) will call with a JSON string for opts.
    const stringOpts = globalThis.__render(
      { elements: [], appState: {} },
      '{"embedScene":true}',
    );
    expect(typeof stringOpts.then).toBe("function");
    await stringOpts.catch(() => {});

    // Deno dev (J-009) may pass an object or omit opts entirely.
    const objectOpts = globalThis.__render(
      { elements: [], appState: {} },
      { embedScene: true },
    );
    expect(typeof objectOpts.then).toBe("function");
    await objectOpts.catch(() => {});

    const noOpts = globalThis.__render({ elements: [], appState: {} });
    expect(typeof noOpts.then).toBe("function");
    await noOpts.catch(() => {});
  });
});
