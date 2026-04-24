// tests/js/font-strict-fonts.test.mjs — FNT-009
//
// Exercise the `opts.strictFonts: true` flag added to src/core/index.mjs.
// Policy (PLAN §4A.5):
//   - Default (permissive): unknown numeric fontFamily IDs fall back to
//     Excalifont metrics without error. The scene still renders; the
//     emitted `font-family` string may contain arbitrary names.
//   - `strictFonts: true`: after rendering, any `<text font-family="…">`
//     whose FIRST family is NOT in ALLOWED_FIRST_FAMILIES causes
//     `__render` to reject with an Error listing the offending names.
//
// How to engineer an "unknown first family" scene. Upstream's
// getFontFamilyString maps numeric IDs → fixed family strings; passing an
// unknown numeric id falls through to WINDOWS_EMOJI_FALLBACK_FONT ("Segoe
// UI Emoji"), not to an arbitrary name. The cleanest way to inject an
// unknown first family into the SVG is to set `fontFamily` to an unknown
// numeric id (e.g. 99) — upstream emits "Segoe UI Emoji" as first family,
// which is NOT in the allowlist (it's never bundled; PLAN §4A.6). That
// path exercises the same guard the task describes.

import { describe, it, expect, beforeAll } from "vitest";
import { resolve } from "node:path";

const HELVETICA_SCENE = {
  type: "excalidraw",
  version: 2,
  source: "test",
  elements: [
    {
      id: "text-hel",
      type: "text",
      x: 50,
      y: 50,
      width: 300,
      height: 40,
      angle: 0,
      strokeColor: "#1e1e1e",
      backgroundColor: "transparent",
      fillStyle: "solid",
      strokeWidth: 2,
      strokeStyle: "solid",
      roughness: 1,
      opacity: 100,
      groupIds: [],
      frameId: null,
      index: "a0",
      roundness: null,
      seed: 50001,
      version: 1,
      versionNonce: 1,
      isDeleted: false,
      boundElements: null,
      updated: 1700000000000,
      link: null,
      locked: false,
      text: "Strict Helvetica",
      fontSize: 20,
      fontFamily: 2, // Helvetica — allowed (aliased to Liberation)
      textAlign: "left",
      verticalAlign: "top",
      containerId: null,
      originalText: "Strict Helvetica",
      lineHeight: 1.25,
      autoResize: true,
    },
  ],
  appState: { viewBackgroundColor: "#ffffff", gridSize: null },
  files: {},
};

// Same scene, but with a fontFamily numeric id that upstream does not
// recognise. Upstream's getFontFamilyString falls back to Segoe UI Emoji
// for unknown IDs (see packages/common/src/utils.ts:94, the for-of over
// FONT_FAMILY only hits entries 1..10). "Segoe UI Emoji" is NOT in our
// allowlist (PLAN §4A.6 marks it as local-only), so strictFonts must
// reject.
const UNKNOWN_FONT_SCENE = {
  ...HELVETICA_SCENE,
  elements: [
    {
      ...HELVETICA_SCENE.elements[0],
      id: "text-unknown",
      text: "Strict Unknown",
      originalText: "Strict Unknown",
      fontFamily: 99, // not in upstream FONT_FAMILY → Segoe UI Emoji first
    },
  ],
};

describe("FNT-009 strictFonts opt", () => {
  beforeAll(async () => {
    globalThis.location ??= {
      href: "http://localhost/",
      origin: "http://localhost",
    };
    await import(resolve("dist/core.mjs"));
  });

  it("default (strictFonts undefined): Helvetica scene renders fine", async () => {
    const r = await globalThis.__render(HELVETICA_SCENE);
    expect(r.svg).toMatch(/<svg/);
    expect(r.svg).toMatch(/font-family="Helvetica/);
  });

  it("default (strictFonts undefined): unknown-family scene renders (permissive fallback)", async () => {
    // Excalifont-metric fallback for the provider + SVG still emitted
    // with whatever upstream chose as the first family.
    const r = await globalThis.__render(UNKNOWN_FONT_SCENE);
    expect(r.svg).toMatch(/<svg/);
  });

  it("strictFonts: true — allowed family (Helvetica) still passes", async () => {
    const r = await globalThis.__render(HELVETICA_SCENE, { strictFonts: true });
    expect(r.svg).toMatch(/font-family="Helvetica/);
  });

  it("strictFonts: true — rejects unknown first family with a listing error", async () => {
    await expect(
      globalThis.__render(UNKNOWN_FONT_SCENE, { strictFonts: true }),
    ).rejects.toThrow(/Unsupported font families/);
  });

  it("strictFonts passed via JSON string opts (Rust host path) also rejects", async () => {
    // R-003 will call __render with a JSON string for opts. Verify the
    // guard fires on that code path too (index.mjs normalizes opts when a
    // string is passed).
    await expect(
      globalThis.__render(UNKNOWN_FONT_SCENE, '{"strictFonts":true}'),
    ).rejects.toThrow(/Unsupported font families/);
  });
});
