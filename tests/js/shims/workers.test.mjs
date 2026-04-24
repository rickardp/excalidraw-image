// Unit tests for src/core/shims/workers.mjs (J-006).
//
// The shim's single job is to ensure `typeof globalThis.Worker === "undefined"`
// before Excalidraw's subset-main.ts evaluates, so that `shouldUseWorkers`
// is captured as `false`. See PLAN.md §4.2 and upstream SVG_EXPORT.md §3.4.
//
// Node (the vitest host) does NOT expose `Worker` on globalThis by default
// (Node 22+ has `Worker` via `node:worker_threads`, but it is not a global).
// Deno DOES expose `Worker`. To cover both hosts deterministically, we plant
// a fake Worker on globalThis before calling the shim and assert it is wiped.

import { describe, it, expect, afterEach } from "vitest";

describe("installWorkersShim", () => {
  afterEach(() => {
    // Keep the test environment clean for sibling tests.
    try {
      delete globalThis.Worker;
    } catch {
      globalThis.Worker = undefined;
    }
  });

  it("leaves Worker untouched before installation", async () => {
    // Importing the module must have no top-level side effects.
    await import("../../../src/core/shims/workers.mjs");
    // In Node (vitest's host) Worker is not a global by default; if a future
    // host exposes one, the test below still proves the shim wipes it.
    expect(typeof globalThis.Worker).toBe("undefined");
  });

  it("wipes a pre-existing Worker global (Deno-like host)", async () => {
    // Simulate the Deno host, which defines `globalThis.Worker`.
    globalThis.Worker = function FakeWorker() {};
    expect(typeof globalThis.Worker).toBe("function");

    const { installWorkersShim } = await import(
      "../../../src/core/shims/workers.mjs"
    );
    installWorkersShim();
    expect(typeof globalThis.Worker).toBe("undefined");
  });

  it("leaves Worker undefined when the host did not define it", async () => {
    // Node/deno_core-like: Worker absent before install, absent after.
    expect(typeof globalThis.Worker).toBe("undefined");
    const { installWorkersShim } = await import(
      "../../../src/core/shims/workers.mjs"
    );
    installWorkersShim();
    expect(typeof globalThis.Worker).toBe("undefined");
  });

  it("is idempotent: calling twice does not throw and keeps Worker undefined", async () => {
    const { installWorkersShim } = await import(
      "../../../src/core/shims/workers.mjs"
    );
    expect(() => installWorkersShim()).not.toThrow();
    expect(() => installWorkersShim()).not.toThrow();
    expect(typeof globalThis.Worker).toBe("undefined");
  });

  it("second install after a re-planted Worker is a no-op (module-level latch)", async () => {
    // First install runs (or has run in a prior test); module sets installed=true.
    const { installWorkersShim } = await import(
      "../../../src/core/shims/workers.mjs"
    );
    installWorkersShim();
    // Plant a new Worker. Because the shim is idempotent by design (single
    // install per module load), it will NOT re-wipe. This mirrors the
    // contract of the sibling shims (installDomShim, installWebGlobalsShim).
    globalThis.Worker = function FakeWorker() {};
    installWorkersShim();
    expect(typeof globalThis.Worker).toBe("function");
  });
});
