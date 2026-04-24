// tests/js/embed-scene.test.mjs — E-001
//
// E-001 scope is narrow: confirm that opts.embedScene wires through to
// Excalidraw's `appState.exportEmbedScene` and that the resulting SVG
// carries the four marker tokens that define the `.excalidraw.svg`
// envelope (upstream SVG_EXPORT.md §3.5):
//
//   <!-- svg-source:excalidraw -->
//   <metadata>
//     <!-- payload-type:application/vnd.excalidraw+json -->
//     <!-- payload-version:2 -->
//     <!-- payload-start -->
//     <base64 json>
//     <!-- payload-end -->
//   </metadata>
//
// This test intentionally does NOT:
//   - Exercise linkedom's comment/text-node serialization behavior in
//     depth (E-002 owns that — linkedom could in principle collapse or
//     reorder children inside <metadata>, and E-002's regex + mitigation
//     plan is where that risk lives).
//   - Decode the base64 payload and deep-equal the scene back to the
//     input (E-003 owns the full decode + round-trip gate; it depends on
//     @excalidraw/excalidraw/data/encode).
//
// If either of those higher-fidelity assertions is needed, run E-002 or
// E-003. This file is the "the plumbing is hooked up" gate and nothing
// more.

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("E-001 --embed-scene wiring", () => {
  let svgPlain;
  let svgEmbed;

  beforeAll(async () => {
    globalThis.location ??= { href: "http://localhost/", origin: "http://localhost" };
    await import(resolve("dist/core.mjs"));
    const scene = readFileSync("tests/fixtures/basic-shapes.excalidraw", "utf8");
    const r1 = await globalThis.__render(scene);
    const r2 = await globalThis.__render(scene, JSON.stringify({ embedScene: true }));
    svgPlain = r1.svg;
    svgEmbed = r2.svg;
  });

  it("without embedScene: no payload markers in the SVG", () => {
    // Upstream note (/Users/rickard/oss/excalidraw/packages/excalidraw/scene/export.ts:364,374):
    // `<!-- svg-source:excalidraw -->` and `<metadata>` are emitted
    // UNCONDITIONALLY by Excalidraw's export path. Only the payload-start
    // / payload-end comments (and the base64 body between them) are gated
    // on `appState.exportEmbedScene`. So the right plain-SVG assertion is
    // "no payload-start / payload-end", not "no svg-source".
    expect(svgPlain).not.toContain("payload-start");
    expect(svgPlain).not.toContain("payload-end");
    // An empty <metadata /> can still appear in the plain output — this is
    // fine and expected, and does not carry a base64 payload.
  });

  it("with embedScene: all four payload markers present", () => {
    expect(svgEmbed).toContain("<!-- svg-source:excalidraw -->");
    expect(svgEmbed).toContain("<metadata>");
    expect(svgEmbed).toContain("payload-start");
    expect(svgEmbed).toContain("payload-end");
  });

  it("payload block is between payload-start and payload-end", () => {
    const m = svgEmbed.match(/<!-- payload-start -->([\s\S]+?)<!-- payload-end -->/);
    expect(m).toBeTruthy();
    const payload = m[1].trim();
    expect(payload.length).toBeGreaterThan(10);
    // base64 alphabet check (may include = padding and whitespace):
    expect(payload.replace(/\s/g, "")).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  it("the embedded scene is structurally present (non-empty payload)", () => {
    const m = svgEmbed.match(/<!-- payload-start -->([\s\S]+?)<!-- payload-end -->/);
    const b64 = m[1].replace(/\s/g, "");
    expect(b64.length).toBeGreaterThan(100);
  });
});
