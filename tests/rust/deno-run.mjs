// R-007 — parity gate Deno driver.
//
// This file is the JS side of the Deno-vs-Rust byte-identity gate
// (the implementation notes). Both runtimes read the same fixture and emit the same
// SVG bytes; any divergence is a host leak and blocks the gate.
//
// Why this file exists — and why `src/core/dev.mjs` is NOT what we diff:
//
//   `src/core/dev.mjs` imports `src/core/index.mjs`, which does a
//   dynamic `import("@excalidraw/excalidraw")`. That specifier is
//   unresolvable under raw Deno (J-009 documented the `roughjs/bin/rough`
//   resolver quirk against upstream's raw source). So the dev entry
//   that *does* work under Deno is the esbuild-bundled `dist/core.mjs`
//   — the exact same bytes that `build.rs` embeds into the Rust
//   binary. Diffing bundled-Deno vs bundled-Rust is the sharpest
//   apples-to-apples signal we can get.
//
// Contract:
//   deno run --allow-read tests/rust/deno-run.mjs <fixture.excalidraw>
//
// Output: raw SVG bytes written to stdout with no trailing newline so
// the output matches the Rust binary byte-for-byte. `console.log` adds
// a newline and would therefore break byte-identity — do NOT use it.

// Populate globalThis.__embeddedFonts BEFORE importing dist/core.mjs.
// fetch-fonts.mjs and text-metrics.mjs (inside the bundle) read from this
// global at render time. The Rust shell populates the same global from its
// font sub-crates via include_bytes!.
//
// Resolve the fonts dir relative to this script's location so cargo test
// (which sets a different cwd) finds it.
{
  const here = new URL(".", import.meta.url).pathname;
  const fontsRoot = `${here}../../node_modules/@excalidraw/excalidraw/dist/prod/fonts`;
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

import "../../dist/core.mjs";

const path = Deno.args[0];
if (!path) {
  console.error("usage: deno run --allow-read tests/rust/deno-run.mjs <fixture.excalidraw>");
  Deno.exit(1);
}

try {
  const scene = await Deno.readTextFile(path);
  const { svg } = await globalThis.__render(scene);
  const bytes = new TextEncoder().encode(svg);
  // Deno.stdout.write may short-write on a pipe (~200 bytes at a time when the
  // sink is a shell pipe, observed on macOS). Loop until we've drained the
  // buffer. Missing this loop silently truncated parity output to 207 bytes
  // and caused every parity test to fail with "deno produced a shorter SVG".
  let written = 0;
  while (written < bytes.length) {
    const n = await Deno.stdout.write(bytes.subarray(written));
    if (n <= 0) throw new Error(`Deno.stdout.write returned ${n}; aborting`);
    written += n;
  }
} catch (err) {
  console.error(err?.stack ?? String(err));
  Deno.exit(1);
}
