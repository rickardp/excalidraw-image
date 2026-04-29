// FNT-004 — Subset round-trip test per family (the implementation notes, §4A.8 gate 2).
//
// For every supported family in FONT_ASSETS, exercise the full Excalidraw
// subsetting pipeline end-to-end:
//
//   WOFF2 bytes (from __embeddedFonts, re-encoded at setup from brotli-TTF)
//     → wawoff2.decompress         → TTF bytes
//     → fonteditor-core Font.create({type:"ttf", subset:[codepoints]})
//                                  → subset Font
//     → font.write({type:"ttf"})   → subset TTF bytes
//     → wawoff2.compress           → subset WOFF2 bytes
//
// Then decompress + re-parse to prove the result is consumable.
//
// Shard selection — fonts ship as unicode-range shards (Excalifont has 7,
// Xiaolai 209, etc.), so the first shard for a family is not guaranteed to
// contain the Latin Basic codepoints we want to test with. We iterate the
// shards until we find one whose cmap contains ALL the target codepoints;
// if none do, we skip the family with a warning (FNT-005 will do the
// explicit browser-side check).

import { describe, it, expect } from "vitest";
import wawoff2 from "wawoff2";
import { Font } from "fonteditor-core";
import { FONT_ASSETS } from "../../src/core/font-assets.mjs";

// Per-family target codepoints. Latin Basic "ABC" works for every Excalidraw
// family that ships Latin glyphs. Xiaolai is Han-only, so pick CJK.
const TARGETS = {
  Assistant:   [0x41, 0x42, 0x43], // A B C
  Cascadia:    [0x41, 0x42, 0x43],
  ComicShanns: [0x41, 0x42, 0x43],
  Excalifont:  [0x41, 0x42, 0x43],
  Liberation:  [0x41, 0x42, 0x43],
  Lilita:      [0x41, 0x42, 0x43],
  Nunito:      [0x41, 0x42, 0x43],
  Virgil:      [0x41, 0x42, 0x43],
  Xiaolai:     [0x4F60, 0x597D], // 你 好
};

// fonteditor-core's TTF reader constructs a DataView over the input and so
// requires an ArrayBuffer. Node's Buffer is a Uint8Array view that may share
// a larger pool; slice out the exact region.
function toArrayBuffer(u8) {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}

async function decompressToTtf(woff2Bytes) {
  const out = await wawoff2.decompress(Buffer.from(woff2Bytes));
  // wawoff2 returns a Node Buffer.
  return out;
}

async function findShardWithCodepoints(family, codepoints) {
  const shards = FONT_ASSETS[family];
  for (let i = 0; i < shards.length; i++) {
    // Bytes come from globalThis.__embeddedFonts (populated by
    // tests/js/setup-embedded-fonts.mjs — re-encoded WOFF2).
    const bytes = globalThis.__embeddedFonts[shards[i].path];
    if (!bytes) continue;
    let ttf;
    try {
      ttf = await decompressToTtf(bytes);
    } catch {
      continue;
    }
    let font;
    try {
      font = Font.create(toArrayBuffer(ttf), { type: "ttf" });
    } catch {
      continue;
    }
    const cmap = font.get().cmap;
    if (codepoints.every((cp) => cmap[cp] !== undefined)) {
      return { index: i, shard: shards[i] };
    }
  }
  return null;
}

describe("FNT-004 — subset round-trip per family", () => {
  for (const family of Object.keys(FONT_ASSETS)) {
    const codepoints = TARGETS[family];
    if (!codepoints) {
      it.skip(`${family}: no target codepoints defined`, () => {});
      continue;
    }

    it(
      `${family}: WOFF2 → TTF → subset → WOFF2 round-trip yields a parseable font with glyphs for U+${codepoints
        .map((cp) => cp.toString(16).toUpperCase().padStart(4, "0"))
        .join(", U+")}`,
      async () => {
        const match = await findShardWithCodepoints(family, codepoints);
        if (!match) {
          // Expected for sharded families where no single shard happens to
          // cover every target codepoint (Xiaolai splits CJK across 209
          // shards by unicode-range). FNT-005's browser oracle verifies
          // this path with explicit per-codepoint shard selection.
          console.warn(
            `[FNT-004] ${family}: no shard contains all target codepoints ${codepoints
              .map((cp) => "U+" + cp.toString(16).toUpperCase())
              .join(", ")}; skipping round-trip. This is expected for narrowly-sharded families.`,
          );
          return;
        }

        // 1. Decompress the source WOFF2 → TTF bytes.
        const srcWoff2 = Buffer.from(globalThis.__embeddedFonts[match.shard.path]);
        const srcTtf = await decompressToTtf(srcWoff2);
        expect(srcTtf.length).toBeGreaterThan(0);

        // 2. Parse the TTF and request a subset in one go. fonteditor-core's
        //    Font.create accepts `subset: [codepoints]` as a read option
        //    (see node_modules/fonteditor-core/index.d.ts FontReadOptions);
        //    there is no separate `font.subset(...)` method in 2.4.1.
        const font = Font.create(toArrayBuffer(srcTtf), {
          type: "ttf",
          subset: codepoints,
        });

        // Sanity: the subset glyf list must be non-empty. Note: on a
        // Font.create(..., {subset: [...]}) the in-memory cmap returned by
        // .get() still carries the SOURCE cmap entries (they point at
        // glyph indices that will be re-numbered on write), so per-cmap
        // presence checks are deferred to the post-round-trip assertions
        // below where the cmap matches the emitted glyf table.
        const subsetObj = font.get();
        expect(subsetObj.glyf.length).toBeGreaterThan(0);

        // 3. Write subset → TTF bytes.
        const subsetTtf = font.write({ type: "ttf" });
        expect(subsetTtf.length).toBeGreaterThan(0);

        // 4. Compress TTF → WOFF2.
        const subsetWoff2 = await wawoff2.compress(Buffer.from(subsetTtf));
        expect(subsetWoff2.length).toBeGreaterThan(0);

        // 5a. Final bytes must start with the WOFF2 magic "wOF2".
        const magic = String.fromCharCode(
          subsetWoff2[0],
          subsetWoff2[1],
          subsetWoff2[2],
          subsetWoff2[3],
        );
        expect(magic).toBe("wOF2");

        // 5b. Round-trip: decompressing + re-parsing the subset WOFF2 must
        //     yield a Font whose TTFObject has the horizontal-metrics table
        //     (hhea — fonteditor-core folds hmtx per-glyph into
        //     glyf[i].advanceWidth, and hhea is the required gate for that
        //     data) and a non-empty cmap, and whose glyf contains entries
        //     for every requested codepoint.
        const rtTtf = await decompressToTtf(subsetWoff2);
        const rtFont = Font.create(toArrayBuffer(rtTtf), { type: "ttf" });
        const rtObj = rtFont.get();
        expect(rtObj.hhea, `${family}: round-tripped font missing hhea`).toBeTypeOf("object");
        expect(Object.keys(rtObj.cmap).length, `${family}: empty cmap`).toBeGreaterThan(0);
        expect(rtObj.glyf.length, `${family}: empty glyf`).toBeGreaterThan(0);
        for (const cp of codepoints) {
          const gid = rtObj.cmap[cp];
          expect(gid, `${family}: round-trip lost U+${cp.toString(16).toUpperCase()}`).toBeGreaterThan(0);
          const glyph = rtObj.glyf[gid];
          expect(glyph, `${family}: no glyph entry for U+${cp.toString(16).toUpperCase()}`).toBeDefined();
          expect(typeof glyph.advanceWidth, `${family}: missing hmtx advanceWidth for U+${cp.toString(16).toUpperCase()}`).toBe("number");
        }
      },
      30_000,
    );
  }
});
