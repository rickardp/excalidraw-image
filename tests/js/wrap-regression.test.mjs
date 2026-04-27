// tests/js/wrap-regression.test.mjs — T-006 (scope-reduced)
//
// Snapshot-based line-wrap regression gate.
//
// SCOPE NOTE. The implementation notes gate-5 ideal is a live Playwright oracle
// against excalidraw.com. That infrastructure is deferred to FNT-005,
// which needs Playwright anyway for font-fidelity comparisons; this file
// is the best-we-can-do-without-a-browser version: a baseline captured
// once from our own CLI output, asserted in subsequent runs within loose
// tolerances. Its job is to catch CATASTROPHIC regressions (e.g., wrap
// math goes off the rails, the bundle starts emitting zero text) without
// being so strict that every sub-pixel fontkit metric drift from a
// dependency bump trips it. FNT-005 will replace/strengthen the
// line-count assertion with real browser-measured break columns.
//
// How wrap lines appear in Excalidraw's SVG output (upstream verified in
// /Users/rickard/oss/excalidraw/packages/excalidraw/renderer/staticSvgScene.ts
// around line 648–689): `element.text` is split on "\n", and each line
// produces ITS OWN <text> element (NOT a single <text> with multiple
// <tspan>s, and NOT a single <text> with multiple y/dy deltas). So for a
// text element with N lines we see N sibling <text> nodes under the
// element's group <g>. Upstream pre-wraps text via
// `element.refreshTextDimensions()` on input/resize; the fixture file's
// `text` field is expected to already contain the "\n" wraps the editor
// inserted.
//
// Our fixture (tests/fixtures/text-wrapped.excalidraw) stores the
// paragraphs WITHOUT any embedded "\n", so the current CLI output emits
// one <text> per paragraph = 1 line apiece. That is the captured baseline
// value. If a future metric change causes Excalidraw's export path to
// start wrapping on export (e.g., by calling refreshTextDimensions), the
// ±1 tolerance absorbs that for paragraph #1 but not for the 500 px
// container with 5+ expected lines — the gate would catch that, which is
// the point.

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("T-006 wrap-regression gate", () => {
  let svg;
  let expected;
  let textElements;

  beforeAll(async () => {
    // Load bundle (requires `make core` first). The bundle assumes a
    // browser-ish host; `location` is the one global it reads at
    // module-eval time that Node doesn't provide. See src/core/index.mjs
    // and the J-010 completion note in the original task board.
    globalThis.location ??= {
      href: "http://localhost/",
      origin: "http://localhost",
    };
    await import(resolve("dist/core.mjs"));

    const scene = readFileSync(
      "tests/fixtures/text-wrapped.excalidraw",
      "utf8",
    );
    const r = await globalThis.__render(scene);
    svg = r.svg;

    expected = JSON.parse(
      readFileSync("tests/fixtures/text-wrapped.expected.json", "utf8"),
    );

    // Extract every <text ...>...</text> element (full outerHTML-style).
    // Text elements are always siblings inside the same group, so a plain
    // regex captures them in document order — good enough for snapshot.
    textElements = [
      ...svg.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/g),
    ].map((m) => ({
      outer: m[0],
      inner: m[1],
    }));
  });

  it("produces the expected number of text elements", () => {
    // For wrapping to count right, this is the sum of (linesPerParagraph)
    // across all paragraphs. With the baseline of 1 line per paragraph
    // for both the 300 px and 500 px containers, it equals the paragraph
    // count exactly.
    const expectedMin = expected.textElements.reduce(
      (sum, p) => sum + Math.max(1, p.lineCount - 1),
      0,
    );
    const expectedMax = expected.textElements.reduce(
      (sum, p) => sum + p.lineCount + 1,
      0,
    );
    expect(textElements.length).toBeGreaterThanOrEqual(expectedMin);
    expect(textElements.length).toBeLessThanOrEqual(expectedMax);
  });

  it("line count per paragraph is within ±1 of baseline", () => {
    // Upstream emits one <text> node per wrapped line (see file header).
    // Group observed <text> nodes back into paragraphs by matching each
    // inner textContent against the `firstChars` prefix of the expected
    // entries. Any <text> whose content starts with a known prefix
    // belongs to that paragraph's line-count bucket; additional adjacent
    // lines inherit the most-recent matched bucket (they are wrap
    // continuations without a prefix of their own).
    const buckets = expected.textElements.map((p) => ({
      firstChars: p.firstChars,
      baseline: p.lineCount,
      observed: 0,
    }));
    let current = -1;
    for (const { inner } of textElements) {
      // inner may contain XML-escaped characters; the prefixes in the
      // expected file are plain text and shorter than 20 chars, so direct
      // startsWith suffices for the current fixture. If a paragraph ever
      // starts with a character that Excalidraw escapes (<, >, &), switch
      // to a decoded comparison.
      const matched = buckets.findIndex((b) => inner.startsWith(b.firstChars));
      if (matched >= 0) {
        current = matched;
      }
      if (current >= 0) {
        buckets[current].observed += 1;
      }
    }

    const failures = buckets
      .filter((b) => Math.abs(b.observed - b.baseline) > 1)
      .map(
        (b) =>
          `  "${b.firstChars}…": baseline=${b.baseline} observed=${b.observed} (diff=${b.observed - b.baseline})`,
      );
    expect(
      failures,
      `line-count drift exceeds ±1 per paragraph:\n${failures.join("\n")}`,
    ).toEqual([]);
  });

  it("SVG length is within ±10% of baseline (weak size regression)", () => {
    const len = svg.length;
    expect(len).toBeGreaterThan(expected.svgLength * 0.9);
    expect(len).toBeLessThan(expected.svgLength * 1.1);
  });
});
