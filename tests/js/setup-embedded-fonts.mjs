// Vitest global setup: pre-populates globalThis.__embeddedFonts with WOFF2
// bytes from the pre-generated blob (assets/embedded_fonts_js.{bin,json}).
//
// The blob is produced by `node src/scripts/build-woff2-blob.mjs` using
// wawoff2 (the same WASM WOFF2 encoder). The Rust binary's build.rs reads
// the same blob, guaranteeing byte-identical WOFF2 across all runtimes.
//
// Wired via vitest.config.mjs `setupFiles`.

import { readFileSync } from "node:fs";

const BLOB_PATH = "crates/excalidraw-image/assets/embedded_fonts_js.bin";
const INDEX_PATH = "crates/excalidraw-image/assets/embedded_fonts_js.json";

let map = {};
try {
  const blob = readFileSync(BLOB_PATH);
  const index = JSON.parse(readFileSync(INDEX_PATH, "utf8"));
  for (const { key, offset, length } of index) {
    map[key] = new Uint8Array(blob.buffer, blob.byteOffset + offset, length).slice();
  }
} catch {
  // Blob may not exist if build-woff2-blob.mjs hasn't run — tests that need
  // fonts will fail with a clear error from fetch-fonts.mjs anyway.
}
globalThis.__embeddedFonts = map;
