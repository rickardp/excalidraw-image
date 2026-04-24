// Unit tests for src/core/shims/web-globals.mjs (J-002).
// Import dom.mjs first so `window` exists (and the shim mirrors onto it),
// then install web-globals and exercise one assertion per covered global.

import { describe, it, expect, beforeAll } from "vitest";

describe("installWebGlobalsShim", () => {
  beforeAll(async () => {
    const { installDomShim } = await import(
      "../../../src/core/shims/dom.mjs"
    );
    installDomShim();
    const { installWebGlobalsShim } = await import(
      "../../../src/core/shims/web-globals.mjs"
    );
    installWebGlobalsShim();
    // Idempotency: second call must be a no-op.
    installWebGlobalsShim();
  });

  it("btoa encodes hello correctly", () => {
    expect(globalThis.btoa("hello")).toBe("aGVsbG8=");
  });

  it("atob(btoa(x)) round-trips non-ASCII input", () => {
    const s = "héllo"; // "héllo"
    expect(globalThis.atob(globalThis.btoa(s))).toBe(s);
  });

  it("URL.searchParams.get returns query parameter", () => {
    const u = new globalThis.URL("https://a/b?c=1");
    expect(u.searchParams.get("c")).toBe("1");
  });

  it("TextEncoder/TextDecoder round-trips non-ASCII via UTF-8", () => {
    const enc = new globalThis.TextEncoder();
    const dec = new globalThis.TextDecoder();
    expect(dec.decode(enc.encode("ü"))).toBe("ü");
  });

  it("EventTarget addEventListener + dispatchEvent fires the receiver", () => {
    const t = new globalThis.EventTarget();
    let fired = 0;
    t.addEventListener("ping", () => {
      fired += 1;
    });
    t.dispatchEvent(new globalThis.Event("ping"));
    expect(fired).toBe(1);
  });

  it("DOMException exposes the given name", () => {
    const e = new globalThis.DOMException("msg", "NotFoundError");
    expect(e.name).toBe("NotFoundError");
  });

  it("performance.now returns a non-negative number", () => {
    const t = globalThis.performance.now();
    expect(typeof t).toBe("number");
    expect(t).toBeGreaterThanOrEqual(0);
  });

  it("setTimeout invokes the callback (awaiting a 0ms timer)", async () => {
    await new Promise((resolve) => {
      globalThis.setTimeout(resolve, 0);
    });
  });

  it("mirrors globals onto window too", () => {
    expect(globalThis.window.btoa).toBeDefined();
    expect(globalThis.window.URL).toBeDefined();
    expect(globalThis.window.TextEncoder).toBeDefined();
    expect(globalThis.window.Event).toBeDefined();
    expect(globalThis.window.EventTarget).toBeDefined();
    expect(globalThis.window.DOMException).toBeDefined();
    expect(globalThis.window.performance).toBeDefined();
    expect(globalThis.window.setTimeout).toBeDefined();
  });
});
