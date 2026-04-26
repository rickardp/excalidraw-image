// src/core/dev.mjs — J-009
//
// Deno-only dev entry point. This is the ONE file in src/core/ that's allowed
// to reference `Deno.*`; eslint's host-neutrality rule (P-002) exempts it.
// Production goes through the Rust shell (R-004); this exists solely to power
// the fast dev loop and the Deno-vs-Rust parity gate (R-007).
//
// Contract (PLAN.md §4.1.1):
//   deno run --allow-read src/core/dev.mjs <input.excalidraw>
// Prints the rendered SVG to stdout. Exit 0 on success, 1 on any error.

if (typeof Deno === "undefined") {
  throw new Error("dev.mjs runs only under Deno");
}

// Populate globalThis.__embeddedFonts BEFORE importing index.mjs. The
// fetch-fonts and text-metrics shims (installed by index.mjs's import chain)
// look up bytes here at render time. The Rust shell populates the same global
// from include_bytes! in the font sub-crates; both hosts feed the same shim
// with the same byte-for-byte content (parity gate R-007).
{
  const fontsRoot = "node_modules/@excalidraw/excalidraw/dist/prod/fonts";
  const map = {};
  async function* walkWoff2(dir) {
    for await (const entry of Deno.readDir(dir)) {
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory) {
        yield* walkWoff2(full);
      } else if (entry.isFile && entry.name.toLowerCase().endsWith(".woff2")) {
        yield full;
      }
    }
  }
  for await (const full of walkWoff2(fontsRoot)) {
    const rel = full.slice(fontsRoot.length + 1);
    map[rel] = await Deno.readFile(full);
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
