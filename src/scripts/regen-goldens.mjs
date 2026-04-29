#!/usr/bin/env node
// Regenerates tests/fixtures/<name>.svg.golden for every .excalidraw fixture.
// NOT run automatically — invoke when an export-path change is intentional:
//   make goldens   (or: node src/scripts/regen-goldens.mjs)
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixturesDir = resolve(repoRoot, "tests", "fixtures");
const bundlePath = resolve(repoRoot, "dist", "core.mjs");

// Populate __embeddedFonts from the pre-generated WOFF2 blob (same data as
// vitest setup and the Rust binary).
{
  const blobPath = resolve(repoRoot, "crates/excalidraw-image/assets/embedded_fonts_js.bin");
  const indexPath = resolve(repoRoot, "crates/excalidraw-image/assets/embedded_fonts_js.json");
  const blob = readFileSync(blobPath);
  const index = JSON.parse(readFileSync(indexPath, "utf8"));
  const map = {};
  for (const { key, offset, length } of index) {
    map[key] = new Uint8Array(blob.buffer, blob.byteOffset + offset, length).slice();
  }
  globalThis.__embeddedFonts = map;
}

globalThis.location ??= { href: "http://localhost/", origin: "http://localhost" };
await import(pathToFileURL(bundlePath).href);

const fixtures = readdirSync(fixturesDir).filter(f => f.endsWith(".excalidraw"));
let regenerated = 0;
for (const f of fixtures) {
  const sceneJson = readFileSync(resolve(fixturesDir, f), "utf8");
  const { svg } = await globalThis.__render(sceneJson);
  const goldenPath = resolve(fixturesDir, f.replace(/\.excalidraw$/, ".svg.golden"));
  writeFileSync(goldenPath, svg);
  regenerated++;
}
console.log(`regenerated ${regenerated} goldens in ${fixturesDir}`);
