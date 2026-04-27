#!/usr/bin/env node
// src/scripts/browser-font-baseline.mjs — FNT-005
//
// Regenerates tests/fixtures/browser-font-baseline.json with per-family
// browser canvas.measureText widths for a fixed test string. The baseline
// is used by tests/js/browser-fidelity.test.mjs to check that our fontkit-
// based FontkitTextMetricsProvider agrees with Chromium's native
// canvas.measureText within ±2 px per 100-char string (the implementation notes gate 3).
//
// The baseline is *committed*. This script is only run manually when we
// want to refresh it (dep bump, new family, etc.). The test itself does
// NOT launch Playwright — it reads the JSON and re-measures locally.
//
// Practical deviation from the implementation notes strict "unmodified Excalidraw web
// app" oracle: excalidraw.com is too fragile for a CI loop. We self-host
// the same WOFF2 bytes Excalidraw ships (our bundled FONT_ASSETS) and
// measure with the browser's canvas — identical font bytes, identical
// shaping stack, stable enough to commit.
//
// Usage:
//   node src/scripts/browser-font-baseline.mjs
//   npm run baseline:fonts
//
// Xiaolai shard selection: Xiaolai ships as ~200 unicode-range shards.
// FONT_UNICODE_RANGES is currently empty (see src/core/font-assets.mjs),
// so we pick the correct shard by probing each one with fontkit and
// keeping the first shard that carries a glyph for EVERY codepoint in the
// test string. That shard alone is embedded in the test page's @font-face,
// which keeps the HTML size reasonable.

import * as fontkit from "fontkit";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { FONT_ASSETS } from "../core/font-assets.mjs";
import { chromium } from "@playwright/test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const OUT_FILE = resolve(
  REPO_ROOT,
  "tests",
  "fixtures",
  "browser-font-baseline.json",
);

// Families we want widths for. Keys MUST match FONT_ASSETS keys so we can
// look up WOFF2 bytes. See src/core/font-assets.mjs for the canonical
// names — "ComicShanns" has no space, "Lilita" is the directory name for
// Lilita One, etc. We use the same keys in CSS so the test page and the
// fontkit side are measuring the exact same identifier.
const LATIN_TEST = "The quick brown fox jumps over the lazy dog";
// Xiaolai ships as 209 per-codepoint shards; no single shard covers an
// arbitrary CJK string. Our FontkitTextMetricsProvider currently picks
// one shard per call (see the TODO(FNT-009) in src/core/text-metrics.mjs),
// so the baseline string must live entirely within one shard or the
// fontkit side returns 0. These 12 common Chinese characters all live in
// the same Xiaolai shard — verified against the current font-assets.mjs.
// If a future dep bump reshards Xiaolai, pick a new 12-char set from
// whichever shard carries the most common CJK codepoints.
const CJK_TEST = "的一是了我不人在他有中国";

const FAMILIES = [
  { family: "Excalifont", text: LATIN_TEST },
  { family: "Virgil", text: LATIN_TEST },
  { family: "Nunito", text: LATIN_TEST },
  { family: "Lilita", text: LATIN_TEST },
  { family: "ComicShanns", text: LATIN_TEST },
  { family: "Cascadia", text: LATIN_TEST },
  { family: "Liberation", text: LATIN_TEST },
  { family: "Xiaolai", text: CJK_TEST },
];

const FONT_SIZE = 20;

function base64ToBytes(b64) {
  const bin = Buffer.from(b64, "base64");
  return new Uint8Array(bin.buffer, bin.byteOffset, bin.byteLength);
}

function shardCoversText(shardBytes, text) {
  const font = fontkit.create(shardBytes);
  for (const ch of text) {
    if (!font.hasGlyphForCodePoint(ch.codePointAt(0))) return false;
  }
  return true;
}

// For Latin families: pick the first shard that covers all codepoints of
// the test string. Falls back to shard 0 (task spec: "first non-empty
// subset") if none cover. For Xiaolai specifically, this finds the
// CJK-range shard containing 你好世界... even though the family has
// hundreds of shards split by codepoint.
function selectShardForText(family, text) {
  const shards = FONT_ASSETS[family];
  if (!shards || shards.length === 0) {
    throw new Error(`No FONT_ASSETS entry for family ${family}`);
  }
  for (const shard of shards) {
    const bytes = base64ToBytes(shard.base64);
    if (shardCoversText(bytes, text)) {
      return shard;
    }
  }
  // Nothing fully covers — use shard 0 as the last resort.
  return shards[0];
}

function buildHtml(selections) {
  // We register fonts via the FontFace API (not CSS @font-face) and await
  // each .load() explicitly. Chrome is lazy about CSS-declared fonts —
  // they only load when a rendered element uses them — which is why the
  // initial CSS-only approach produced fallback-font widths for every
  // family. Adding FontFace instances to document.fonts + awaiting each
  // load() bypasses that optimization and guarantees the glyph metrics
  // are available to canvas.measureText below.
  //
  // We still echo the family name into a visible <div> as a belt-and-
  // suspenders check — tofu there would be visible in non-headless mode.
  const entries = selections.map(({ family, shard }) => ({
    family,
    dataUrl: `data:font/woff2;base64,${shard.base64}`,
  }));
  const entriesJson = JSON.stringify(entries);

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  body { margin: 0; padding: 0; font-family: sans-serif; }
  .probe { font-size: 20px; visibility: hidden; }
</style>
</head>
<body>
<div id="status">loading</div>
<div id="probes"></div>
<script>
  (async () => {
    const entries = ${entriesJson};
    for (const { family, dataUrl } of entries) {
      const face = new FontFace(family, "url(" + dataUrl + ")");
      const loaded = await face.load();
      document.fonts.add(loaded);

      // Touch a visible DOM node with the family so the browser is
      // forced to shape with the font, not just keep it in a dormant
      // FontFace set. (Not strictly required after face.load(), but
      // a second defense against the lazy-load trap.)
      const probe = document.createElement("span");
      probe.className = "probe";
      probe.style.fontFamily = "'" + family + "'";
      probe.textContent = "probe";
      document.getElementById("probes").appendChild(probe);
    }
    await document.fonts.ready;
    document.getElementById("status").textContent = "ready";
    window.__measure = (family, pxSize, text) => {
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      ctx.font = pxSize + "px '" + family + "'";
      return ctx.measureText(text).width;
    };
  })().catch((err) => {
    document.getElementById("status").textContent = "error: " + err.message;
  });
</script>
</body>
</html>`;
}

async function main() {
  // 1. Select a shard per family that covers the test string.
  const selections = FAMILIES.map(({ family, text }) => {
    const shard = selectShardForText(family, text);
    return { family, text, shard };
  });

  // 2. Build the HTML page and hand it to headless Chromium.
  const html = buildHtml(selections);
  const browser = await chromium.launch({ headless: true });
  const browserVersion = browser.version();
  const context = await browser.newContext();
  const page = await context.newPage();

  // Surface console + page errors so a font load failure doesn't look
  // like a silent "returns fallback width" (see task "known challenges").
  page.on("pageerror", (err) => console.error("[page error]", err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") console.error("[console]", msg.text());
  });

  await page.setContent(html, { waitUntil: "domcontentloaded" });

  // Wait for the async fonts.ready + window.__measure installation. The
  // page script sets #status="ready" after document.fonts.ready resolves.
  await page.waitForFunction(
    () =>
      typeof window.__measure === "function" &&
      document.getElementById("status")?.textContent === "ready",
    null,
    { timeout: 30000 },
  );

  // 3. For each family, measure the text string with canvas.measureText.
  const families = {};
  for (const { family, text } of FAMILIES) {
    const width = await page.evaluate(
      ({ family, size, text }) => window.__measure(family, size, text),
      { family, size: FONT_SIZE, text },
    );
    if (typeof width !== "number" || !isFinite(width) || width <= 0) {
      throw new Error(
        `Invalid width for ${family}: ${width} — likely a font-load failure.`,
      );
    }
    families[family] = { text, width };
    console.error(
      `  ${family.padEnd(12)}  ${text.length} chars  width=${width.toFixed(4)} px`,
    );
  }

  await browser.close();

  // 4. Write the committed baseline JSON.
  const payload = {
    $comment:
      `Per-family browser canvas.measureText widths. Generated by ` +
      `src/scripts/browser-font-baseline.mjs. Chromium ${browserVersion}. ` +
      `Edit via 'npm run baseline:fonts' + commit.`,
    fontSize: FONT_SIZE,
    families,
  };

  await mkdir(dirname(OUT_FILE), { recursive: true });
  await writeFile(OUT_FILE, JSON.stringify(payload, null, 2) + "\n", "utf8");

  console.error(`\nWrote ${OUT_FILE}`);
  console.error(`  chromium:  ${browserVersion}`);
  console.error(`  families:  ${Object.keys(families).length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
