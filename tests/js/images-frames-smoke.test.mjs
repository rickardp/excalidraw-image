// tests/js/images-frames-smoke.test.mjs — I-004
//
// Phase 4 (images + frames) smoke gates. Imports the bundled
// `dist/core.mjs` directly (same pattern as embed-scene.test.mjs /
// bundle-smoke.test.mjs) and renders each of the three Phase 4 fixtures
// once, then asserts key structural properties of the emitted SVG.
//
// Scope:
//   - I-001 (image.excalidraw):          preserves dataURL href on <image>
//   - I-002 (image-cropped.excalidraw):  emits a mask or clipPath and the
//                                        image references it (directly via
//                                        mask=/clip-path= or indirectly via
//                                        a <symbol> pulled in by <use>)
//   - I-003 (frames.excalidraw):         two clipPaths (one per frame) plus
//                                        the short label "Hi" verbatim and
//                                        the long label truncated with an
//                                        ellipsis marker ("..." or "…")
//
// This file does NOT:
//   - Validate frame-child clipping semantics (R-007 / D-004 golden-SVG
//     snapshots own bit-for-bit fidelity).
//   - Decode the dataURL — I-001's acceptance is that the href round-trips
//     as a string, not that the bytes decode to a valid PNG.

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("I-004 Phase 4 fixtures (images + frames) smoke", () => {
  let svgImage;
  let svgImageCropped;
  let svgFrames;

  beforeAll(async () => {
    globalThis.location ??= {
      href: "http://localhost/",
      origin: "http://localhost",
    };
    await import(resolve("dist/core.mjs"));

    const sceneImage = readFileSync(
      "tests/fixtures/image.excalidraw",
      "utf8",
    );
    const sceneImageCropped = readFileSync(
      "tests/fixtures/image-cropped.excalidraw",
      "utf8",
    );
    const sceneFrames = readFileSync(
      "tests/fixtures/frames.excalidraw",
      "utf8",
    );

    svgImage = (await globalThis.__render(sceneImage)).svg;
    svgImageCropped = (await globalThis.__render(sceneImageCropped)).svg;
    svgFrames = (await globalThis.__render(sceneFrames)).svg;
  });

  describe("I-001 image.excalidraw", () => {
    it("emits exactly one <image> tag", () => {
      const imageTags = svgImage.match(/<image\s/g) || [];
      expect(imageTags.length).toBe(1);
    });

    it("preserves the dataURL href", () => {
      expect(svgImage).toContain('href="data:image/');
    });

    it("is a well-formed <svg>…</svg> envelope", () => {
      expect(svgImage.startsWith("<svg")).toBe(true);
      expect(svgImage.trimEnd().endsWith("</svg>")).toBe(true);
    });
  });

  describe("I-002 image-cropped.excalidraw", () => {
    it("emits exactly one <image> tag", () => {
      const imageTags = svgImageCropped.match(/<image\s/g) || [];
      expect(imageTags.length).toBe(1);
    });

    it("emits at least one <clipPath> or <mask> element", () => {
      const clipCount = (svgImageCropped.match(/<clipPath/g) || []).length;
      const maskCount = (svgImageCropped.match(/<mask\b/g) || []).length;
      expect(clipCount + maskCount).toBeGreaterThanOrEqual(1);
    });

    it("the <image> references the mask/clipPath (direct attribute or <symbol>/<use>)", () => {
      const hasDirectMaskRef = / mask="/.test(svgImageCropped);
      const hasDirectClipRef = /clip-path="/.test(svgImageCropped);
      const hasSymbolUse =
        /<symbol\b/.test(svgImageCropped) && /<use\s/.test(svgImageCropped);
      expect(hasDirectMaskRef || hasDirectClipRef || hasSymbolUse).toBe(true);
    });
  });

  describe("I-003 frames.excalidraw", () => {
    // Raw long label — must be present in the fixture source but NOT in
    // the emitted SVG (the frame-header renderer truncates via fontkit-
    // backed canvas.measureText).
    const LONG_LABEL_RAW =
      "A deliberately long frame label that should exceed the header width and force truncation via canvas measureText";

    it("emits at least 2 <clipPath> elements (one per frame's clip region)", () => {
      const clipCount = (svgFrames.match(/<clipPath/g) || []).length;
      expect(clipCount).toBeGreaterThanOrEqual(2);
    });

    it("the short frame label 'Hi' appears in a <text> node", () => {
      // Render emits frame names as standalone <text …>Hi</text> nodes.
      expect(svgFrames).toMatch(/<text[^>]*>Hi</);
    });

    it("the long frame label is truncated (raw absent, prefix + ellipsis marker present)", () => {
      expect(svgFrames).not.toContain(LONG_LABEL_RAW);

      // Truncation marker is ASCII "..." or Unicode "…" per upstream
      // scene/export.ts:69. A prefix of the raw label must precede it.
      const prefix = LONG_LABEL_RAW.slice(0, 8); // "A delibe"
      const truncatedAscii = new RegExp(
        `${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^<]*\\.\\.\\.`,
      );
      const truncatedUnicode = new RegExp(
        `${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^<]*…`,
      );
      expect(
        truncatedAscii.test(svgFrames) || truncatedUnicode.test(svgFrames),
      ).toBe(true);
    });
  });
});
