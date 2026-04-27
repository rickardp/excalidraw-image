// tests/js/font-helvetica-alias.test.mjs — FNT-008
//
// Helvetica (scene fontFamily id=2) must:
//   (a) emit `font-family="Helvetica, …"` on the `<text>` element so that
//       .excalidraw.svg payloads round-trip the user's chosen family
//       (the implementation notes point 3: we NEVER rewrite the attribute); and
//   (b) be MEASURED with Liberation Sans metrics via the T-001 alias map
//       in src/core/text-metrics.mjs (FAMILY_ALIASES = { Helvetica:
//       "Liberation" }).
//
// This test loads the shipped bundle (dist/core.mjs) under vitest/Node and
// renders a minimal one-text scene. It asserts both behaviours:
//   1. The output SVG contains a `font-family` attribute whose first name
//      is exactly "Helvetica".
//   2. The shared FontkitTextMetricsProvider reports the same width for
//      "20px Helvetica" and "20px Liberation" (alias routing). This is the
//      only metric signal we can observe from the SVG alone without
//      measuring glyph advances inside <text> — which upstream does not
//      emit as `<tspan dx>` in the SVG export path (see
//      staticSvgScene.ts:672).
//
// Why not assert SVG width of the <text> box? Excalidraw's export doesn't
// compute a rendered text bbox — it just sets x/y/font-family/font-size.
// The MEASUREMENT side effect (Liberation metrics) shows up in container
// layout (wrap widths) and in the provider output, not in `<text>` geometry.

import { describe, it, expect, beforeAll } from "vitest";
import { resolve } from "node:path";

// Minimal scene with a single text element, fontFamily: 2 (Helvetica).
// Upstream's getFontFamilyString maps id 2 → "Helvetica, sans-serif, Segoe
// UI Emoji" (see packages/common/src/utils.ts:94 + constants.ts:132).
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
      seed: 40001,
      version: 1,
      versionNonce: 1,
      isDeleted: false,
      boundElements: null,
      updated: 1700000000000,
      link: null,
      locked: false,
      text: "Hello Helvetica",
      fontSize: 20,
      fontFamily: 2,
      textAlign: "left",
      verticalAlign: "top",
      containerId: null,
      originalText: "Hello Helvetica",
      lineHeight: 1.25,
      autoResize: true,
    },
  ],
  appState: { viewBackgroundColor: "#ffffff", gridSize: null },
  files: {},
};

describe("FNT-008 Helvetica → Liberation aliasing", () => {
  let svg;

  beforeAll(async () => {
    // See tests/js/wrap-regression.test.mjs header: bundle reads
    // window.location.origin at module-eval; Node doesn't provide one.
    globalThis.location ??= {
      href: "http://localhost/",
      origin: "http://localhost",
    };
    await import(resolve("dist/core.mjs"));

    const r = await globalThis.__render(HELVETICA_SCENE);
    svg = r.svg;
  });

  it("emits a <text> element", () => {
    expect(svg).toMatch(/<text\b[^>]*>/);
  });

  it("keeps Helvetica as the first family in the SVG font-family attribute", () => {
    // Find every font-family on a <text> node (there may be one per wrapped
    // line; for this scene there's exactly one line so one attribute).
    const matches = [...svg.matchAll(/<text\b[^>]*font-family="([^"]+)"/g)];
    expect(matches.length).toBeGreaterThan(0);
    for (const [, fam] of matches) {
      expect(fam).toContain("Helvetica");
      // the implementation notes: we MUST NOT rewrite the attribute to Liberation.
      expect(fam).not.toMatch(/^Liberation/);
      const first = fam.split(",")[0].trim().replace(/^['"]|['"]$/g, "");
      expect(first).toBe("Helvetica");
    }
  });

  it("measures Helvetica text with Liberation Sans metrics (T-001 alias)", async () => {
    const { FontkitTextMetricsProvider } = await import(
      "../../src/core/text-metrics.mjs"
    );
    const p = new FontkitTextMetricsProvider();
    const helvetica = p.getLineWidth("Hello Helvetica", "20px Helvetica");
    const liberation = p.getLineWidth("Hello Helvetica", "20px Liberation");
    // Identical, not just "close": the alias routes the query to the
    // SAME fontkit Font object, so widths are bit-identical.
    expect(helvetica).toBe(liberation);
    // And distinct from Excalifont — otherwise the alias is a no-op and
    // this test wouldn't prove anything.
    const excalifont = p.getLineWidth("Hello Helvetica", "20px Excalifont");
    expect(helvetica).not.toBe(excalifont);
  });
});
