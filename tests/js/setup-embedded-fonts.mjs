// Vitest global setup: pre-populates globalThis.__embeddedFonts with WOFF2
// bytes from node_modules so the same fetch-fonts / text-metrics / fontkit
// code paths work under Node-hosted vitest. The Rust shell and the Deno dev
// path do the equivalent at their own startup.
//
// Wired via vitest.config.mjs `setupFiles`.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const FONTS_ROOT = "node_modules/@excalidraw/excalidraw/dist/prod/fonts";

function walkWoff2(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walkWoff2(full));
    else if (st.isFile() && name.toLowerCase().endsWith(".woff2")) out.push(full);
  }
  return out;
}

const map = {};
for (const full of walkWoff2(FONTS_ROOT)) {
  const rel = relative(FONTS_ROOT, full).split("\\").join("/");
  map[rel] = readFileSync(full);
}
globalThis.__embeddedFonts = map;
