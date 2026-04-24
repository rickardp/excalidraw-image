// Unit tests for src/core/shims/fetch-fonts.mjs (J-004).
// Vitest; not jsdom. The shim under test depends on DOM (J-001) + atob
// (J-002). J-002 installs `atob` on globalThis when absent; in Node vitest
// `atob` already exists natively, so the manual install branch in the test
// is defensive.
//
// Acceptance (TASKS.md J-004):
//   - URL matching a FONT_ASSETS entry path → Response with ok=true and
//     .arrayBuffer() returning bytes that begin with the WOFF2 magic "wOF2".
//   - data: URL resolves via host fetch when available (conditional).
//   - Unrecognized URL rejects with "network fetch not allowed".
//   - Idempotent install (calling twice does not double-wrap).

import { describe, it, expect, beforeAll } from "vitest";
import { FONT_ASSETS } from "../../../src/core/font-assets.mjs";

describe("installFetchFontsShim", () => {
  beforeAll(async () => {
    // Satisfy J-001 (globalThis / window) so the shim can mirror onto window.
    const { installDomShim } = await import(
      "../../../src/core/shims/dom.mjs"
    );
    installDomShim();

    // Satisfy J-002 where possible. If the file doesn't exist yet, fall
    // back to a manual atob install (Node provides atob natively from v16).
    try {
      const mod = await import("../../../src/core/shims/web-globals.mjs");
      if (typeof mod.installWebGlobalsShim === "function") {
        mod.installWebGlobalsShim();
      }
    } catch {
      if (typeof globalThis.atob !== "function") {
        // Very defensive — Node/Vitest has atob. Keep this branch cheap.
        globalThis.atob = (s) => Buffer.from(s, "base64").toString("binary");
      }
    }

    const { installFetchFontsShim } = await import(
      "../../../src/core/shims/fetch-fonts.mjs"
    );
    installFetchFontsShim();
  });

  it("serves a real FONT_ASSETS entry and yields WOFF2 bytes", async () => {
    const entry = FONT_ASSETS.Excalifont[0];
    expect(entry).toBeTruthy();
    const url = `https://example.invalid/dist/prod/fonts/${entry.path}`;

    const res = await fetch(url);
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);

    const buf = await res.arrayBuffer();
    expect(buf).toBeInstanceOf(ArrayBuffer);
    expect(buf.byteLength).toBeGreaterThan(4);

    const bytes = new Uint8Array(buf);
    const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
    expect(magic).toBe("wOF2");
  });

  it("handles data: URLs when the host fetch supports them", async () => {
    // In Node ≥ 21 `fetch` supports data:. If the host doesn't support it,
    // the shim falls back to an inline parser — in either case .text()
    // must round-trip.
    const res = await fetch("data:text/plain,hello");
    expect(res.ok).toBe(true);
    const txt = await res.text();
    expect(txt).toBe("hello");
  });

  it("rejects unknown URLs with 'network fetch not allowed'", async () => {
    await expect(
      fetch("https://excalidraw-does-not-exist.example/foo"),
    ).rejects.toThrow(/network fetch not allowed/);
  });

  it("is idempotent: calling install twice does not double-wrap", async () => {
    const { installFetchFontsShim } = await import(
      "../../../src/core/shims/fetch-fonts.mjs"
    );
    const first = globalThis.fetch;
    installFetchFontsShim();
    installFetchFontsShim();
    expect(globalThis.fetch).toBe(first);

    // And the wrapper still behaves the same.
    const entry = FONT_ASSETS.Excalifont[0];
    const url = `https://example.invalid/dist/prod/fonts/${entry.path}`;
    const res = await fetch(url);
    expect(res.ok).toBe(true);
  });
});
