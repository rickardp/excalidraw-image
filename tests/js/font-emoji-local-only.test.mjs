// tests/js/font-emoji-local-only.test.mjs — FNT-010
//
// Emoji policy (PLAN §4A.6):
//   - No `@font-face` is emitted for "Segoe UI Emoji" (local-only upstream
//     — Excalidraw's Emoji/ directory contains only `src: local(...)`
//     descriptors with no WOFF2 bytes to embed). Same for Helvetica.
//   - The `font-family` attribute on `<text>` nodes KEEPS "Segoe UI Emoji"
//     in the fallback list when upstream put it there. The goal is
//     editable .excalidraw.svg round-trip fidelity: viewers with the
//     system font installed will see emoji glyphs; others see tofu (an
//     explicit, documented limitation).
//
// NOTE on skipInliningFonts. Our render() call passes `skipInliningFonts:
// true` (src/core/index.mjs §4.3). Empirically that flag does NOT remove
// `@font-face` rules for Excalidraw's OWN bundled families (Xiaolai,
// Excalifont still appear as data-URL faces in `<defs><style>` because
// upstream's `renderer/renderElement.ts:getSvgFontFaces` gathers them
// from the fonts store). What the flag controls is a separate inline
// step. Either way, the "no @font-face for Segoe" assertion holds
// because emoji has no WOFF2 to inline in the first place — the
// local-only descriptor is the source of the guarantee, not the
// skipInliningFonts flag.
//
// Fixture: tests/fixtures/mixed-script.excalidraw (FNT-006). Its text
// contains Latin + CJK + emoji. fontFamily id=5 → "Excalifont, Xiaolai,
// Segoe UI Emoji" per FONT_FAMILY_FALLBACKS for Excalifont (see
// packages/common/src/constants.ts getFontFamilyFallbacks).

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("FNT-010 emoji local-only handling", () => {
  let svg;

  beforeAll(async () => {
    globalThis.location ??= {
      href: "http://localhost/",
      origin: "http://localhost",
    };
    await import(resolve("dist/core.mjs"));

    const scene = readFileSync(
      "tests/fixtures/mixed-script.excalidraw",
      "utf8",
    );
    const r = await globalThis.__render(scene);
    svg = r.svg;
  });

  it("emits valid SVG for the mixed-script fixture", () => {
    expect(svg).toMatch(/^<svg\b/);
  });

  it("does NOT emit an @font-face for Segoe UI Emoji", () => {
    // Case-insensitive match across any `@font-face { … font-family:
    // Segoe UI Emoji … }` block, scanned as a single pre-brace run to
    // catch both regular and escaped variants.
    expect(svg).not.toMatch(/@font-face[^}]*Segoe\s*UI\s*Emoji/i);
  });

  it("does NOT emit an @font-face for Helvetica (other local-only family)", () => {
    // Same policy as emoji (PLAN §4A.6): Helvetica upstream is a
    // local-only descriptor with no WOFF2 to embed. Metrics are routed
    // to Liberation Sans via the T-001 alias, but no @font-face rule
    // should name Helvetica.
    expect(svg).not.toMatch(/@font-face[^}]*Helvetica/i);
  });

  it("keeps 'Segoe UI Emoji' in the font-family fallback list on <text>", () => {
    // Upstream's getFontFamilyString for Excalifont (id=5) produces
    // "Excalifont, Xiaolai, sans-serif, Segoe UI Emoji" (see
    // getFontFamilyFallbacks in constants.ts and the WINDOWS_EMOJI_FALLBACK_FONT
    // constant). Assert the emoji family name survives into the SVG.
    const matches = [...svg.matchAll(/<text\b[^>]*font-family="([^"]+)"/g)];
    expect(matches.length).toBeGreaterThan(0);
    // At least one <text> should still reference Segoe UI Emoji in its
    // fallback list (not as first family — it sits last).
    const hasEmojiFallback = matches.some(([, fam]) =>
      /Segoe\s*UI\s*Emoji/.test(fam),
    );
    expect(hasEmojiFallback).toBe(true);
  });
});
