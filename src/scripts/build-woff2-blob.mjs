// Generates the pre-encoded WOFF2 blob + index for the Rust binary's JS engine
// path. Excalidraw's subsetter expects WOFF2 input (it calls woff2Dec
// internally), so __embeddedFonts must contain WOFF2 bytes.
//
// This script reads brotli-compressed TTF (.ttf.br) from font sub-crate dirs,
// decompresses via zlib, re-encodes TTF→WOFF2 via wawoff2 (the same WASM
// encoder that Deno/vitest use), and writes:
//
//   crates/excalidraw-image/assets/embedded_fonts_js.bin   — concatenated WOFF2 blob
//   crates/excalidraw-image/assets/embedded_fonts_js.json  — index: [{key, offset, length}]
//
// build.rs reads these at compile time so no WOFF2 re-encoding happens in Rust.
// Using the same encoder (wawoff2) for both Deno and Rust guarantees parity.
//
// Run: node src/scripts/build-woff2-blob.mjs
// Wired into `make fonts` and `make core` (run before `cargo build`).

import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import { brotliDecompressSync } from "node:zlib";
import wawoff2 from "wawoff2";

const FONTS_DIRS = [
  "crates/excalidraw-image-fonts-core/fonts",
  "crates/excalidraw-image-fonts-cjk/fonts",
  "crates/excalidraw-image-fonts-cjk-extra/fonts",
];

const ASSETS_DIR = "crates/excalidraw-image/assets";

function walkTtfBr(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walkTtfBr(full));
    else if (st.isFile() && name.toLowerCase().endsWith(".ttf.br")) out.push(full);
  }
  return out;
}

async function main() {
  // Collect all .ttf.br files, sorted by .woff2 key for deterministic output.
  const files = [];
  for (const fontsDir of FONTS_DIRS) {
    try {
      for (const full of walkTtfBr(fontsDir)) {
        const rel = relative(fontsDir, full).split("\\").join("/");
        const key = rel.replace(/\.ttf\.br$/, ".woff2");
        files.push({ full, fontsDir, key });
      }
    } catch {
      // Font dir may not exist
    }
  }
  files.sort((a, b) => a.key.localeCompare(b.key));

  if (files.length === 0) {
    console.error("[build-woff2-blob] no .ttf.br files found — run `npm run sync-fonts` first");
    process.exit(1);
  }

  // Re-encode each TTF→WOFF2 and concatenate into a single blob.
  const chunks = [];
  const index = [];
  let offset = 0;

  for (const { full, key } of files) {
    const compressed = readFileSync(full);
    const ttf = brotliDecompressSync(compressed);
    const woff2 = await wawoff2.compress(Buffer.from(ttf));
    // Copy out of WASM memory before it's reused on next call.
    const bytes = new Uint8Array(woff2).slice();
    chunks.push(bytes);
    index.push({ key, offset, length: bytes.length });
    offset += bytes.length;
  }

  const blob = Buffer.concat(chunks);

  mkdirSync(ASSETS_DIR, { recursive: true });
  writeFileSync(join(ASSETS_DIR, "embedded_fonts_js.bin"), blob);
  writeFileSync(join(ASSETS_DIR, "embedded_fonts_js.json"), JSON.stringify(index));

  console.log(
    `[build-woff2-blob] wrote ${files.length} fonts, ${blob.length} bytes → ${ASSETS_DIR}/embedded_fonts_js.{bin,json}`
  );
}

main();
