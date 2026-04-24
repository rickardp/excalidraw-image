// spike/dev.mjs — Deno dev wrapper for F-001.
//
// Usage:
//   deno run --allow-read spike/dev.mjs <fixture.excalidraw>
//
// Loads the bundled core.mjs (which registers globalThis.__render) and pipes
// the fixture through it, printing the resulting SVG to stdout.

import "./core.mjs";

const path = Deno.args[0];
if (!path) {
  console.error(
    "usage: deno run --allow-read spike/dev.mjs <fixture.excalidraw>",
  );
  Deno.exit(1);
}

const sceneJson = await Deno.readTextFile(path);
const { svg } = await globalThis.__render(sceneJson);
console.log(svg);
