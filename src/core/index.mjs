// src/core/index.mjs — J-008
//
// The JS core's single public entry point. Importing this module:
//   1. Installs every shim (dom, web-globals, fonts, fetch-fonts, canvas,
//      workers) via the side-effect import of ./shims/install.mjs. The shim
//      install MUST run before anything else evaluates — in particular,
//      before Excalidraw's package root is pulled in (which reads
//      `devicePixelRatio`, `document`, etc. at module-eval time).
//   2. Registers `globalThis.__render` — the one and only public surface of
//      the JS core (PLAN.md §4.1). The Rust host (R-003) calls this via a
//      classic-script trampoline; the Deno dev entry (J-009) calls it
//      directly.
//
// Design notes:
// - Excalidraw's `exportToSvg` is imported LAZILY via a dynamic `import()`
//   inside the render function, NOT at top level. Rationale (PHASE0.md
//   Finding A + J-008 task notes):
//     * Under Node (where vitest runs), a top-level
//       `import "@excalidraw/excalidraw"` fails because the package pulls
//       React, JSX runtimes, Radix, Jotai, etc. — all of which esbuild's
//       aliases stub out at BUNDLE time, but Node resolves for real at
//       runtime. Dynamic import lets us load `src/core/index.mjs` in a
//       vitest unit test (this file's tests) without triggering that
//       cascade.
//     * Dynamic import is still statically analyzable by esbuild, so J-010
//       can bundle it into dist/core.mjs normally.
//     * Under deno_core with the bundled core.mjs, the alias has already
//       replaced the import specifier; the dynamic import resolves to the
//       bundled Excalidraw entry.
// - The module has NO top-level side effects beyond the shim install and
//   the `globalThis.__render =` assignment. Nothing is exported (PLAN.md
//   §4.1 — `render` is internal; `globalThis.__render` is the public
//   surface).
// - Host-neutral: no `process`, `Bun`, `Deno`, `fs`, `path`, `node:*`.

import "./shims/install.mjs";

// Lazy, cached loader for exportToSvg. Caching the Promise (not the
// resolved value) means concurrent callers all await the same import.
let exportToSvgPromise;
function loadExportToSvg() {
  exportToSvgPromise ??= import("@excalidraw/excalidraw").then(
    (mod) => mod.exportToSvg,
  );
  return exportToSvgPromise;
}

async function render(sceneJsonOrString, opts = {}) {
  const scene =
    typeof sceneJsonOrString === "string"
      ? JSON.parse(sceneJsonOrString)
      : sceneJsonOrString;

  const exportToSvg = await loadExportToSvg();

  const sceneAppState = scene.appState ?? {};
  const appState = {
    ...sceneAppState,
    exportBackground: opts.background ?? true,
    exportEmbedScene: Boolean(opts.embedScene),
    exportPadding: opts.padding,
    exportScale: opts.scale ?? 1,
    exportWithDarkMode: Boolean(opts.dark),
    viewBackgroundColor: sceneAppState.viewBackgroundColor ?? "#ffffff",
  };

  const svgEl = await exportToSvg(
    {
      elements: scene.elements,
      appState,
      files: scene.files ?? {},
    },
    // §4.3: skipInliningFonts=true — we inject our own @font-face via the
    // font-assets map in a later phase. For J-008's basic-shapes path this
    // simply means no @font-face in the output, which is fine.
    { skipInliningFonts: true },
  );

  return { svg: svgEl.outerHTML };
}

// Public surface. The Rust host (R-003) passes `optsJson` as a JSON string;
// Deno dev (J-009) and unit tests may pass an object (or omit it).
globalThis.__render = (sceneJson, optsJson) =>
  render(
    sceneJson,
    typeof optsJson === "string" ? JSON.parse(optsJson) : (optsJson ?? {}),
  );
