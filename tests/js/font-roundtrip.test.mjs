// tests/js/font-roundtrip.test.mjs — FNT-011
//
// the implementation notes gate 6: ".excalidraw.svg round-trip". Exporting a scene with
// `--embed-scene` and decoding the base64 payload back must yield text
// elements whose `fontFamily` (numeric) exactly equals the input, AND the
// outer SVG's `font-family` attribute on each corresponding <text> node
// must carry the expected family-name string for that ID (FNT-008: we
// preserve the ORIGINAL family name, e.g. `Helvetica`, not `Liberation`).
//
// Scope (deliberately narrow):
//   - Round-trip metadata preservation only. Metric fidelity is FNT-005.
//   - No edits to src/core/**.
//
// E-003 landed before this task did and exports `decodePayload(svg)` from
// tests/js/embed-scene-roundtrip.test.mjs (see its "completion notes"
// referenced in the original task notes + E-003). We import it verbatim so the
// two gates (E-003 shape round-trip, FNT-011 font metadata round-trip)
// share a single decode implementation.

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { decodePayload } from "./embed-scene-roundtrip.test.mjs";

// --- Expected fontFamily ID → family-name-string mapping. ---
// From upstream packages/common/src/constants.ts (FONT_FAMILY) and
// packages/common/src/utils.ts (getFontFamilyString). We assert the FIRST
// family name listed in the <text> `font-family` attribute; fallbacks
// (sans-serif, Segoe UI Emoji, etc.) follow and are not asserted here.
// FNT-008: Helvetica MUST stay as "Helvetica" — NOT rewritten to
// "Liberation" — so embedded scenes round-trip.
const ID_TO_FIRST_FAMILY = {
  1: "Virgil",
  2: "Helvetica",
  3: "Cascadia",
  // 4 is historically unused / Assistant / Obsidian custom.
  5: "Excalifont",
  6: "Nunito",
  7: "Lilita One",
  8: "Comic Shanns",
  9: "Liberation Sans",
};

const FIXTURES = [
  "tests/fixtures/basic-shapes.excalidraw",
  "tests/fixtures/text-wrapped.excalidraw",
  "tests/fixtures/mixed-script.excalidraw",
];

// Collect <text …> font-family attributes in document order.
function collectTextFontFamilies(svg) {
  const out = [];
  const re = /<text\b[^>]*\bfont-family="([^"]+)"/g;
  let m;
  while ((m = re.exec(svg)) !== null) {
    out.push(m[1]);
  }
  return out;
}

describe("FNT-011 font metadata round-trip via --embed-scene", () => {
  beforeAll(async () => {
    // Same shim the other bundle-consuming tests install (see
    // tests/js/embed-scene.test.mjs, font-helvetica-alias.test.mjs):
    // dist/core.mjs reads window.location.origin at module-eval time.
    globalThis.location ??= {
      href: "http://localhost/",
      origin: "http://localhost",
    };
    await import(resolve("dist/core.mjs"));
  });

  for (const fixturePath of FIXTURES) {
    it(`preserves fontFamily metadata for ${fixturePath}`, async () => {
      const sceneText = readFileSync(fixturePath, "utf8");
      const scene = JSON.parse(sceneText);

      // 1. Extract original text elements in document order.
      const originalTexts = scene.elements.filter(
        (el) => el.type === "text" && !el.isDeleted,
      );
      // Some fixtures (basic-shapes) have no text at all — that's a valid
      // degenerate round-trip. Assert it's a no-op for the text path but
      // still exercise the payload encode/decode plumbing.

      // 2. Render with embedScene: true.
      const rendered = await globalThis.__render(sceneText, {
        embedScene: true,
      });
      expect(rendered.svg).toContain("<!-- payload-start -->");
      expect(rendered.svg).toContain("<!-- payload-end -->");

      // 3. Decode payload → recover scene.
      const decoded = decodePayload(rendered.svg);
      expect(decoded).toBeTruthy();
      expect(Array.isArray(decoded.elements)).toBe(true);

      const decodedTexts = decoded.elements.filter(
        (el) => el.type === "text" && !el.isDeleted,
      );

      // 4. Assert 1:1 fontFamily match, aligned by id.
      expect(decodedTexts.length).toBe(originalTexts.length);
      for (const origText of originalTexts) {
        const dec = decodedTexts.find((t) => t.id === origText.id);
        expect(dec, `decoded payload missing text id=${origText.id}`).toBeTruthy();
        expect(
          dec.fontFamily,
          `fontFamily drift for id=${origText.id}`,
        ).toBe(origText.fontFamily);
      }

      // 5. Scan rendered SVG (not the payload) for <text font-family="…">.
      //    Upstream may emit one <text> per wrapped line, so the count can
      //    exceed originalTexts.length. We require: each original text's
      //    expected first-family name appears in the SVG at least once,
      //    and every emitted <text> font-family's first name is one of the
      //    expected first names for originals in this scene.
      const svgFontFamilies = collectTextFontFamilies(rendered.svg);
      if (originalTexts.length === 0) {
        // No text elements → no <text> nodes expected.
        expect(svgFontFamilies.length).toBe(0);
        return;
      }
      expect(svgFontFamilies.length).toBeGreaterThanOrEqual(
        originalTexts.length,
      );

      const expectedFirstNames = new Set(
        originalTexts.map((t) => {
          const name = ID_TO_FIRST_FAMILY[t.fontFamily];
          expect(
            name,
            `no expected first-family mapping for id=${t.fontFamily} (upstream FONT_FAMILY). If upstream added a new id, update ID_TO_FIRST_FAMILY.`,
          ).toBeTruthy();
          return name;
        }),
      );

      // Every emitted <text>'s first family must be one of the expected
      // names for this scene (i.e. no stray unexpected families).
      for (const fam of svgFontFamilies) {
        const first = fam.split(",")[0].trim().replace(/^['"]|['"]$/g, "");
        expect(
          expectedFirstNames.has(first),
          `unexpected SVG font-family first name: "${first}" (attr="${fam}"); expected one of ${[...expectedFirstNames].join(", ")}`,
        ).toBe(true);
      }

      // And every expected family must actually appear at least once.
      for (const name of expectedFirstNames) {
        const seen = svgFontFamilies.some((fam) => {
          const first = fam.split(",")[0].trim().replace(/^['"]|['"]$/g, "");
          return first === name;
        });
        expect(
          seen,
          `expected SVG <text> with font-family starting "${name}" for this fixture; observed: ${svgFontFamilies.join(" | ")}`,
        ).toBe(true);
      }
    });
  }
});
