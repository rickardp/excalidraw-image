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
import { getSharedTextMetricsProvider } from "./text-metrics.mjs";

// FNT-009 — allowlist of font family names that may appear as the FIRST
// family in an emitted `<text font-family="…">` attribute when the caller
// passes `opts.strictFonts: true`. See PLAN.md §4A.5.
//
// Rationale for each entry:
//   - Excalifont, Virgil, Nunito, "Lilita One", "Comic Shanns", Cascadia —
//     the six scene fonts Excalidraw ships as bundled WOFF2s.
//   - "Liberation Sans" — the numeric id 9 family (see
//     packages/common/src/constants.ts FONT_FAMILY). Emitted as-is when a
//     scene sets fontFamily=9.
//   - Helvetica — numeric id 2. We do NOT rewrite the SVG attribute
//     (PLAN §4A.5 point 3: the SVG string must keep Helvetica so
//     .excalidraw.svg payloads round-trip). Metrics are routed to
//     Liberation Sans via FAMILY_ALIASES inside text-metrics.mjs.
//   - Assistant — numeric id 10. Bundled as a WOFF2 in FONT_ASSETS.
//   - Xiaolai — CJK fallback family. Rarely appears FIRST (it normally
//     sits second in the fallback list per getFontFamilyFallbacks), but
//     some scenes/tests emit it first; allow it here to avoid rejecting
//     legitimate CJK-only fixtures.
const ALLOWED_FIRST_FAMILIES = new Set([
  "Excalifont",
  "Virgil",
  "Nunito",
  "Lilita One",
  "Comic Shanns",
  "Cascadia",
  "Liberation Sans",
  "Liberation",
  "Helvetica",
  "Assistant",
  "Xiaolai",
]);

// Extracts the first family name from every `font-family="…"` attribute in
// the SVG. Strips surrounding single/double quotes (CSS allows
// `font-family="'Comic Shanns', sans-serif"`). Returns a de-duplicated
// array preserving insertion order.
function _collectFirstFamilies(svg) {
  const seen = new Set();
  const out = [];
  for (const m of svg.matchAll(/font-family="([^"]+)"/g)) {
    const first = m[1]
      .split(",")[0]
      .trim()
      .replace(/^['"]|['"]$/g, "")
      .trim();
    if (first && !seen.has(first)) {
      seen.add(first);
      out.push(first);
    }
  }
  return out;
}

// Lazy, cached loader for exportToSvg. Caching the Promise (not the
// resolved value) means concurrent callers all await the same import.
//
// T-004: while resolving the module we also register the shared fontkit
// text-metrics provider via `setCustomTextMetricsProvider`. The upstream
// source path is `@excalidraw/element/textMeasurements` (see
// `/Users/rickard/oss/excalidraw/SVG_EXPORT.md` §3.2), but the npm dist of
// `@excalidraw/excalidraw` is a SINGLE bundled package — the subpath import
// is not surfaced by the `exports` map. Verified by grep: the symbol IS
// re-exported from the package root (`mod.setCustomTextMetricsProvider`),
// so we pull it from there.
//
// Without this call, `CanvasTextMetricsProvider` is lazily instantiated by
// Excalidraw on first `getLineWidth` use. That default provider ultimately
// delegates to `document.createElement("canvas").getContext("2d").measureText`
// — which our T-003 canvas shim already routes to the same shared fontkit
// provider. Registering explicitly is still preferable: (a) it matches
// upstream §3.2's recommended API surface, (b) it short-circuits one layer
// of indirection, and (c) it guards against upstream refactoring the default
// provider off of the canvas path in a future version.
let exportToSvgPromise;
function loadExportToSvg() {
  exportToSvgPromise ??= import("@excalidraw/excalidraw").then((mod) => {
    if (typeof mod.setCustomTextMetricsProvider === "function") {
      mod.setCustomTextMetricsProvider(getSharedTextMetricsProvider());
    }
    return mod.exportToSvg;
  });
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

  const svg = svgEl.outerHTML;

  // FNT-009 — strict-fonts gate. When enabled, scan the emitted SVG for any
  // `font-family="…"` attribute whose FIRST family is not in
  // ALLOWED_FIRST_FAMILIES and throw. Default (undefined/false) behavior
  // is permissive: unknown numeric fontFamily IDs fall through to the
  // Excalifont metrics path already wired in text-metrics.mjs. See
  // PLAN §4A.5 for the policy.
  if (opts.strictFonts) {
    const firstFamilies = _collectFirstFamilies(svg);
    const unknown = firstFamilies.filter(
      (f) => !ALLOWED_FIRST_FAMILIES.has(f),
    );
    if (unknown.length > 0) {
      throw new Error(
        `Unsupported font families in scene: ${unknown.join(", ")}`,
      );
    }
  }

  return { svg };
}

// Public surface. The Rust host (R-003) passes `optsJson` as a JSON string;
// Deno dev (J-009) and unit tests may pass an object (or omit it).
globalThis.__render = (sceneJson, optsJson) =>
  render(
    sceneJson,
    typeof optsJson === "string" ? JSON.parse(optsJson) : (optsJson ?? {}),
  );
