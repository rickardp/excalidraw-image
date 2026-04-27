// Unit tests for src/core/shims/fonts.mjs (J-003).
// Vitest; the dom shim must be installed first — fonts.mjs guards on
// `typeof document === "undefined"`. See the implementation notes and §4A.6.

import { describe, it, expect, beforeAll } from "vitest";

describe("installFontsShim", () => {
  beforeAll(async () => {
    const { installDomShim } = await import(
      "../../../src/core/shims/dom.mjs"
    );
    installDomShim();
    const { installFontsShim } = await import(
      "../../../src/core/shims/fonts.mjs"
    );
    installFontsShim();
  });

  it("constructs FontFace preserving all 5 descriptors verbatim", () => {
    const font = new globalThis.FontFace("Virgil", "url(virgil.woff2)", {
      unicodeRange: "U+0000-00FF",
      weight: "400",
      style: "italic",
      display: "swap",
    });
    expect(font.family).toBe("Virgil");
    expect(font.style).toBe("italic");
    expect(font.weight).toBe("400");
    expect(font.display).toBe("swap");
    expect(font.unicodeRange).toBe("U+0000-00FF");
  });

  it("FontFace.load() resolves to the FontFace and flips status to loaded", async () => {
    const font = new globalThis.FontFace("Virgil", "url(x)");
    expect(font.status).toBe("unloaded");
    const resolved = await font.load();
    expect(resolved).toBe(font);
    expect(font.status).toBe("loaded");
  });

  it("FontFace.loaded is a Promise that resolves to the FontFace", async () => {
    const font = new globalThis.FontFace("Virgil", "url(x)");
    expect(font.loaded).toBeInstanceOf(Promise);
    const resolved = await font.loaded;
    expect(resolved).toBe(font);
  });

  it("document.fonts.add / has / check work", () => {
    const font = new globalThis.FontFace("Virgil", "url(x)");
    const ret = globalThis.document.fonts.add(font);
    expect(ret).toBe(globalThis.document.fonts);
    expect(globalThis.document.fonts.has(font)).toBe(true);
    expect(globalThis.document.fonts.check("20px Virgil")).toBe(true);
    expect(globalThis.document.fonts.check("20px Virgil", "hello")).toBe(true);
  });

  it("document.fonts.delete removes a font; has returns false afterward", () => {
    const font = new globalThis.FontFace("Excalifont", "url(x)");
    globalThis.document.fonts.add(font);
    expect(globalThis.document.fonts.has(font)).toBe(true);
    expect(globalThis.document.fonts.delete(font)).toBe(true);
    expect(globalThis.document.fonts.has(font)).toBe(false);
  });

  it("document.fonts.load resolves to an empty array", async () => {
    const result = await globalThis.document.fonts.load("20px Virgil");
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(0);
  });

  it("document.fonts.clear empties the set", () => {
    const font = new globalThis.FontFace("Nunito", "url(x)");
    globalThis.document.fonts.add(font);
    expect(globalThis.document.fonts.has(font)).toBe(true);
    globalThis.document.fonts.clear();
    expect(globalThis.document.fonts.has(font)).toBe(false);
  });

  it("document.fonts.ready resolves", async () => {
    expect(globalThis.document.fonts.ready).toBeInstanceOf(Promise);
    const resolved = await globalThis.document.fonts.ready;
    expect(resolved).toBe(globalThis.document.fonts);
  });

  it("is iterable with [Symbol.iterator] — for..of after add yields N items", () => {
    globalThis.document.fonts.clear();
    const a = new globalThis.FontFace("A", "url(a)");
    const b = new globalThis.FontFace("B", "url(b)");
    globalThis.document.fonts.add(a);
    globalThis.document.fonts.add(b);
    const seen = [];
    for (const f of globalThis.document.fonts) {
      seen.push(f);
    }
    expect(seen.length).toBe(2);
    expect(seen).toContain(a);
    expect(seen).toContain(b);
  });

  it("forEach iterates stored fonts", () => {
    globalThis.document.fonts.clear();
    const a = new globalThis.FontFace("A", "url(a)");
    const b = new globalThis.FontFace("B", "url(b)");
    globalThis.document.fonts.add(a);
    globalThis.document.fonts.add(b);
    const seen = [];
    globalThis.document.fonts.forEach((f) => seen.push(f));
    expect(seen.length).toBe(2);
  });

  it("is idempotent: calling installFontsShim twice does not throw or replace", async () => {
    const { installFontsShim } = await import(
      "../../../src/core/shims/fonts.mjs"
    );
    const firstFontFace = globalThis.FontFace;
    const firstFontsSet = globalThis.document.fonts;
    expect(() => installFontsShim()).not.toThrow();
    expect(() => installFontsShim()).not.toThrow();
    expect(globalThis.FontFace).toBe(firstFontFace);
    expect(globalThis.document.fonts).toBe(firstFontsSet);
  });
});
