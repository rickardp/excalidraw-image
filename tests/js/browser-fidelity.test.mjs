// tests/js/browser-fidelity.test.mjs — FNT-005
//
// Verifies that our FontkitTextMetricsProvider agrees with Chromium's
// native canvas.measureText on a fixed test string per family. This is
// the fontkit-vs-browser metrics parity gate from the implementation notes gate 3.
//
// The comparison is offline: this test never launches a browser. It reads
// the committed tests/fixtures/browser-font-baseline.json (produced by
// src/scripts/browser-font-baseline.mjs) and re-measures locally. That
// keeps the test loop fast, CI-friendly, and stable across environments
// that may not have a browser. Regenerating the baseline is an explicit
// manual step:
//
//   node src/scripts/browser-font-baseline.mjs   # or npm run baseline:fonts
//   git diff tests/fixtures/browser-font-baseline.json
//   git commit ...
//
// Tolerance (from FNT-005 spec): ≤2 px drift per 100-char string, i.e.
// ≤0.02 px per char. The assertion below scales linearly with text length
// so a 43-char string is tested at ±0.86 px and a 100-char string at ±2 px.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { FontkitTextMetricsProvider } from "../../src/core/text-metrics.mjs";

const BASELINE_PATH = resolve("tests/fixtures/browser-font-baseline.json");
const TOLERANCE_PX_PER_CHAR = 0.02; // = 2 px / 100 chars

const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
const pxSize = baseline.fontSize;
const provider = new FontkitTextMetricsProvider();

describe("FNT-005 browser fidelity (fontkit ↔ Chromium canvas.measureText)", () => {
  it("baseline file is well-formed", () => {
    expect(baseline.fontSize).toBe(20);
    expect(Object.keys(baseline.families).length).toBeGreaterThan(0);
    for (const [family, entry] of Object.entries(baseline.families)) {
      expect(typeof entry.text, family).toBe("string");
      expect(entry.text.length, family).toBeGreaterThan(0);
      expect(entry.width, family).toBeGreaterThan(0);
    }
  });

  for (const [family, entry] of Object.entries(baseline.families)) {
    it(`fontkit width for ${family} is within ±${TOLERANCE_PX_PER_CHAR} px/char of the browser baseline`, () => {
      const browserWidth = entry.width;
      const fontkitWidth = provider.getLineWidth(entry.text, `${pxSize}px ${family}`);
      const delta = Math.abs(fontkitWidth - browserWidth);
      const tolerance = TOLERANCE_PX_PER_CHAR * entry.text.length;

      const msg =
        `family=${family}\n` +
        `  text     = ${JSON.stringify(entry.text)} (${entry.text.length} chars)\n` +
        `  browser  = ${browserWidth.toFixed(4)} px\n` +
        `  fontkit  = ${fontkitWidth.toFixed(4)} px\n` +
        `  delta    = ${delta.toFixed(4)} px\n` +
        `  tol(±)   = ${tolerance.toFixed(4)} px  (${TOLERANCE_PX_PER_CHAR} px/char × ${entry.text.length} chars)`;

      expect(delta, msg).toBeLessThanOrEqual(tolerance);
    });
  }
});
