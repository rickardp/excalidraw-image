// src/core/dev.mjs — J-009
//
// Deno-only dev entry point. This is the ONE file in src/core/ that's allowed
// to reference `Deno.*`; eslint's host-neutrality rule (P-002) exempts it.
// Production goes through the Rust shell (R-004); this exists solely to power
// the fast dev loop and the Deno-vs-Rust parity gate (R-007).
//
// Contract (the implementation notes):
//   deno run --allow-read src/core/dev.mjs <input.excalidraw>
// Prints the rendered SVG to stdout. Exit 0 on success, 1 on any error.

if (typeof Deno === "undefined") {
  throw new Error("dev.mjs runs only under Deno");
}

// Populate globalThis.__embeddedFonts BEFORE importing index.mjs. The
// fetch-fonts and text-metrics shims (installed by index.mjs's import chain)
// look up bytes here at render time. The Rust shell populates the same global
// from its pre-generated WOFF2 blob (assets/embedded_fonts_js.{bin,json}).
//
// Reads from the pre-generated WOFF2 blob when available (fast, byte-identical
// to Rust & parity gate). Falls back to re-encoding from .ttf.br via wawoff2
// if the blob hasn't been built yet.
{
  const root = new URL("../../", import.meta.url).pathname;
  const blobPath = `${root}crates/excalidraw-image/assets/embedded_fonts_js.bin`;
  const indexPath = `${root}crates/excalidraw-image/assets/embedded_fonts_js.json`;

  let map = {};
  let usedBlob = false;
  try {
    const blob = await Deno.readFile(blobPath);
    const index = JSON.parse(await Deno.readTextFile(indexPath));
    for (const { key, offset, length } of index) {
      map[key] = new Uint8Array(blob.buffer, blob.byteOffset + offset, length).slice();
    }
    usedBlob = true;
  } catch {
    // Blob not built yet — fall back to re-encoding from .ttf.br
  }

  if (!usedBlob) {
    const { brotliDecompressSync } = await import("node:zlib");
    const wawoff2 = (await import("npm:wawoff2")).default;
    const fontsDirs = [
      `${root}crates/excalidraw-image-fonts-core/fonts`,
      `${root}crates/excalidraw-image-fonts-cjk/fonts`,
      `${root}crates/excalidraw-image-fonts-cjk-extra/fonts`,
    ];
    async function* walkTtfBr(dir) {
      for await (const entry of Deno.readDir(dir)) {
        const full = `${dir}/${entry.name}`;
        if (entry.isDirectory) {
          yield* walkTtfBr(full);
        } else if (entry.isFile && entry.name.toLowerCase().endsWith(".ttf.br")) {
          yield full;
        }
      }
    }
    for (const fontsDir of fontsDirs) {
      try {
        for await (const full of walkTtfBr(fontsDir)) {
          const rel = full.slice(fontsDir.length + 1);
          const key = rel.replace(/\.ttf\.br$/, ".woff2");
          const compressed = await Deno.readFile(full);
          const ttf = brotliDecompressSync(compressed);
          map[key] = new Uint8Array(await wawoff2.compress(ttf)).slice();
        }
      } catch {
        // Font dir may not exist if sync-fonts hasn't been run
      }
    }
  }

  globalThis.__embeddedFonts = map;
}

// Side-effect import: installs shims and registers globalThis.__render.
import "./index.mjs";

const path = Deno.args[0];
if (!path) {
  console.error("usage: deno run --allow-read src/core/dev.mjs <input.excalidraw>");
  Deno.exit(1);
}

try {
  const sceneJson = await Deno.readTextFile(path);
  const { svg } = await globalThis.__render(sceneJson);
  console.log(svg);
} catch (err) {
  console.error(err.message);
  Deno.exit(1);
}
