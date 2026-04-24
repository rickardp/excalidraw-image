// tests/deno/render.test.mjs — J-012
//
// Smoke test for the bundled pipeline: imports dist/core.mjs (the artifact
// that actually ships) and renders the basic-shapes fixture. This is the
// "parity gate" entry point described in PLAN §8.2 — if this passes under
// Deno, the same bundle is expected to work under deno_core (R-003).
//
// Deliberately imports the bundle, not src/core/index.mjs: the bundle is
// what gets embedded in the Rust binary, so testing it validates the
// esbuild alias + stub chain that J-010 set up.
//
// Run: deno test --allow-read tests/deno/

import { assert, assertStringIncludes } from "jsr:@std/assert";

Deno.test("basic-shapes fixture produces valid SVG", async () => {
  // Import the bundle; side-effect registers globalThis.__render.
  await import("../../dist/core.mjs");

  const sceneJson = await Deno.readTextFile(
    "tests/fixtures/basic-shapes.excalidraw",
  );
  const { svg } = await globalThis.__render(sceneJson);

  assert(typeof svg === "string", "svg is a string");
  assertStringIncludes(svg, "<svg");
  assertStringIncludes(svg, "<rect");
  assertStringIncludes(svg, "<path"); // the arrow path(s)
  assert(!svg.includes("undefined"), "output contains 'undefined'");
});
