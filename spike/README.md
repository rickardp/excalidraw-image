# F-001 spike — bundle `@excalidraw/excalidraw` under Deno

Feasibility gate for the `excalidraw-image` project. This directory answers one
question: can we bundle `@excalidraw/excalidraw` from the npm dist such that
(a) it runs under Deno with minimal shims, (b) esbuild tree-shakes React /
editor / i18n out of the graph, and (c) the output SVG opens cleanly.

**Verdict: hypothesis holds.** See §Verdict below for the explicit gate results.

## Layout

| File                | Role |
|---------------------|------|
| `entry.mjs`         | Bundle entry — installs shims, imports `exportToSvg`, exposes `globalThis.__render`. |
| `shims.mjs`         | The minimum browser-surface shims needed for `exportToSvg` to run under Deno. |
| `build.mjs`         | `esbuild` invocation. `node spike/build.mjs` for readable, `--minify` for shipping-size measurement. |
| `dev.mjs`           | Deno dev wrapper: `deno run --allow-read spike/dev.mjs <fixture>`. |
| `core.mjs`          | **Generated.** `esbuild` output; gitignored. |
| `meta.json`         | **Generated.** `esbuild` metafile for auditing. |

## How to reproduce

```sh
# from repo root
node spike/build.mjs
deno run --allow-read spike/dev.mjs tests/fixtures/basic-shapes.excalidraw > /tmp/spike-output.svg
xmllint --noout /tmp/spike-output.svg && echo "well-formed"
```

For size measurement:

```sh
node spike/build.mjs --minify    # writes the same core.mjs but minified
```

## Shims in `shims.mjs`

Installed before the `@excalidraw/excalidraw` import, in order:

| Shim                     | Rationale |
|--------------------------|-----------|
| `linkedom` window/document + `Node`, `Element`, `HTMLElement`, `SVGElement`, `DocumentFragment`, `navigator`, `location` | `exportToSvg` builds an actual `SVGSVGElement` tree. the original implementation plan; SVG_EXPORT.md §3.1 has the full inventory. |
| `window.btoa` / `window.atob` mapped from `globalThis.btoa/atob` | `@excalidraw/excalidraw/data/encode` calls `window.btoa` explicitly (not the global). Deno has `globalThis.btoa` but not `window.btoa`. |
| `FontFace` class + `document.fonts` stub | The export path may construct `FontFace` even with `skipInliningFonts: true` via module-eval-time `new FontFace(...)` in Excalidraw's font registry. |
| `document.createElement("canvas")` → fake 2D context with settable `font` + `measureText(t) → { width: t.length * 8 }` | `scene/export.ts:69` creates a canvas directly (frame-label truncation) — does not go through `setCustomTextMetricsProvider`. The placeholder width is good enough for F-001 (`basic-shapes` has no text). Real fontkit-backed metrics land in T-001/T-003. Non-canvas tags delegate to linkedom. |
| `globalThis.fetch` wrapper | Font URLs (`/fonts/` or `.woff2`) → `Response(null, 404)`. `data:` URLs delegate to host fetch (Deno supports data:). Any other URL throws, so unexpected fetches surface loudly. Real font serving is J-004 / FNT-002. |
| `globalThis.Worker = undefined` | Excalidraw's subset path captures `typeof Worker` at module-eval time. Undefined → in-process subset (no Workers needed). |

### Shims discovered empirically

- `globalThis.devicePixelRatio = 1`. `chunk-K2UTITRG.js` reads it at module-eval
  time (static renderer init). Adding this one line made the bundle loadable.
  Worth noting for J-001 / future DOM shim work: `devicePixelRatio` belongs on
  the `window` global, not `document`.

No other empirical shims needed.

## Import path: `@excalidraw/excalidraw` (package root)

The package root export works. The `dist/prod/index.js` entry re-exports
`exportToSvg` (aliased as `Ca as exportToSvg` in the minified ESM). No
sub-path gymnastics were required.

## Bundle size

| Variant                          | Bytes       | MB    |
|----------------------------------|------------:|------:|
| Unminified (readable, debuggable) | 4,325,539  | 4.13  |
| Minified                         | 3,334,416  | 3.18  |

the original implementation plan target: 1–4 MB for the JS core portion of the binary (the Rust shell
adds V8 + resvg on top). We land at the high end of the target range; still
under it.

## Metafile audit

Running the standard forbidden-path check from the original implementation plan step 4 (excluding
virtual `stub-virtual:` entries that the build plugin creates when it
*replaces* a module, not when the real module leaks through):

```
total real inputs: 270
real forbidden hits: 0  (components/App.tsx, LayerUI.tsx, actions/**, hooks/**, i18n.ts, locales/**, css/**)
```

With virtual stub entries counted:

- `stub-virtual:./locales/*.js` × 54. These are **stubs**, not the real locale
  files — the build replaces the dynamic `import("./locales/...")` calls with
  a tiny no-op module. They appear in `meta.json` `inputs` because esbuild
  records every input it resolves, but they contain no actual locale text.

### Top 20 real inputs by `bytesInOutput`

```
1,850,000  node_modules/@excalidraw/excalidraw/dist/prod/chunk-EIO257PC.js
  628,287  node_modules/@excalidraw/excalidraw/dist/prod/index.js
  586,835  node_modules/@excalidraw/excalidraw/dist/prod/chunk-K2UTITRG.js
  128,527  node_modules/pako/dist/pako.esm.mjs
  106,801  node_modules/image-blob-reduce/dist/image-blob-reduce.esm.mjs
   75,684  node_modules/pica/dist/pica.js
   47,246  node_modules/entities/lib/esm/generated/decode-data-html.js
   32,255  node_modules/htmlparser2/node_modules/entities/dist/esm/generated/decode-data-html.js
   26,940  node_modules/entities/lib/esm/generated/encode-html.js
   24,181  node_modules/htmlparser2/dist/esm/Tokenizer.js
   23,694  node_modules/@excalidraw/excalidraw/dist/prod/chunk-6U3AYISY.js
   15,734  node_modules/roughjs/bin/renderer.js
   14,678  node_modules/cssom/lib/parse.js
   14,593  node_modules/@excalidraw/laser-pointer/dist/esm.js
   14,156  node_modules/htmlparser2/node_modules/entities/dist/esm/decode.js
   14,075  node_modules/htmlparser2/dist/esm/Parser.js
   13,751  node_modules/entities/lib/esm/decode.js
   13,230  node_modules/linkedom/esm/html/element.js
   11,977  node_modules/linkedom/esm/interface/element.js
   11,074  node_modules/css-what/lib/es/parse.js
```

Observations:

- `chunk-EIO257PC.js` (1.85 MB) is the Excalidraw renderer core — the largest
  single input. Expected and unavoidable.
- `pica` (75 KB) and `image-blob-reduce` (107 KB) are editor-only image
  processing; they survive because `chunk-EIO257PC` unconditionally imports
  them. Low priority for stubbing, but candidates for J-010's production
  aliasing pass if we shave size later.
- `htmlparser2` / `entities` / `cssom` / `css-what` / `linkedom` — the whole
  linkedom DOM parser. ~150 KB total. Required.
- No React, no jotai, no radix, no locales. Tree-shaking and stubbing work.

## What the esbuild alias + `.css` empty loader were not sufficient for

Several editor-only dependencies required **stubbing at bundle time** beyond
the the original implementation plan step 2 list (`react`, `react-dom`, `react-dom/client`, `jotai`):

- `@excalidraw/mermaid-to-excalidraw` — pulls in `mermaid`, which pulls in
  `vscode-jsonrpc` and transitively imports Node built-ins (`path`, `os`,
  `crypto`, `net`, `util`) that do not exist under `platform=neutral`. Only
  used by the editor's MermaidToExcalidraw dialog; safe to stub wholesale.
- `@radix-ui/react-*` (entire family — popover/tabs and ~20 primitive subpkgs).
  The popover/tabs packages use top-level `Object.assign(SomeImportedSymbol,
  {...})` patterns that throw if the symbol is stubbed to `undefined`. Easier
  to stub the whole radix tree.
- `jotai-scope`. Its `createIsolation()` is called at module-eval time and the
  return value is destructured. Needed a callable-Proxy stub (see below).
- `react/jsx-runtime`, `react/jsx-dev-runtime`. Standard JSX transform targets.
- `./locales/xx-XX-HASH.js` (all 54 locales) via static `import("./locales/...")`
  calls in `dist/prod/index.js`. Stubbing shaved ~1.7 MB from the bundle.

### How the stub plugin works

The stub for "editor-only" deps is not a plain `export default {}`: it's a
generated virtual ESM module whose default export is a callable `Proxy`. The
Proxy returns itself for every property access (including `default`) and
every function call. This lets downstream code do arbitrary things without
crashing:

- `React.memo(Component)` → returns the Proxy (callable).
- `const { useAtom, Provider } = createIsolation()` — `createIsolation` is
  the Proxy, `createIsolation()` returns the Proxy, destructuring any names
  off it gets more Proxies.
- `Object.assign(CollectionSlot, {...})` — the target is a Proxy (an object),
  not `undefined`, so `Object.assign` succeeds.

The stub also explicitly exports well-known named symbols
(`useState`, `Fragment`, `jsx`, `atom`, `createStore`, etc.) so that named
imports resolve at bundle time; `forwardRef` and `memo` specifically return
their input so surviving JSX call sites don't error.

### Assessment

the original implementation plan step 2's alias list (`react`, `react-dom`, `jotai`, `.css: empty`)
is **necessary but not sufficient**. The real `src/scripts/build-core.mjs`
needs the expanded stub list and the Proxy-based virtual module. This is a
direct deliverable for J-010 — the spike's `build.mjs` is a good blueprint.

## Output inspection

`basic-shapes.excalidraw` → 1,778 bytes of SVG. Passes `xmllint --noout`. No
`undefined` substrings. Structure:

```
<svg ...>
  <!-- svg-source:excalidraw -->
  <metadata />
  <defs><style class="style-fonts">\n      </style></defs>
  <rect fill="#ffffff" .../>                 ← background
  <g transform="translate(10 10) ..."> ... </g>  ← rectangle (rough.js strokes)
  <g stroke-linecap="round">                 ← arrow
    <g transform="..."><path .../></g>
    <g transform="..."><path .../></g>       ← arrowhead 1
    <g transform="..."><path .../></g>       ← arrowhead 2
  </g>
  <mask />                                    ← empty (reserved for image masks)
</svg>
```

Empty `<metadata />` is expected when `exportEmbedScene` is false. Empty
`<mask />` is expected when the scene has no masked elements. Nothing
broken.

## Verdict — the original implementation plan acceptance criteria

- [x] **Bundle runs under Deno.** `deno run --allow-read spike/dev.mjs
  tests/fixtures/basic-shapes.excalidraw` exits 0 and writes an SVG.
- [x] **Output SVG looks right.** Starts with `<svg`, well-formed XML
  (`xmllint` clean), contains a background rect, a rectangle drawn with
  rough.js curves, and the arrow with two arrowheads. No `undefined`,
  no empty wrapper `<g>` around everything, no obvious breakage.
- [x] **No forbidden paths in `meta.json` real inputs.** Zero hits against
  `components/App.tsx`, `components/LayerUI.tsx`, `actions/**`, `hooks/**`,
  `i18n.ts`, `locales/**`, `css/**`. (54 `stub-virtual:./locales/*` entries
  are stub redirects, not real source, and are documented as aliasable.)

Phase 0 hypothesis for F-001 is **accepted**. Proceed to F-002.

## Notes and recommendations for F-002 (Rust spike with `deno_core`)

1. **TLA / dynamic import nuance.** The bundle has no top-level `await`. It
   has one set of `import("./locales/...")` dynamic-import sites that are
   replaced by stub-virtual loads and compiled into ESM static imports by
   esbuild. `deno_core`'s `NoopModuleLoader` should be fine because the
   bundle is a single file with no runtime imports surviving.
2. **Promise returned from `__render`.** `exportToSvg` is async, so
   `__render` returns a `Promise<{ svg }>`. The Rust host must use
   `rt.resolve_value(promise)` per the original implementation plan to await; it cannot simply
   read the value synchronously.
3. **Globals the bundle expects before `__render` is called.** All are set
   by `shims.mjs`, which runs before the `exportToSvg` import. The Rust
   host does not need to install anything — it's all inside `core.mjs`.
4. **Evaluation order assumption.** `globalThis.Worker` is set to
   `undefined` inside `shims.mjs`, which is imported at the top of
   `entry.mjs`. Excalidraw's subset module reads `typeof Worker` at its own
   eval time. Because esbuild emits ESM in import order, and `shims.mjs` is
   the first import in `entry.mjs`, this works. Do not reorder in F-002.
5. **Base64 depends on host `btoa`/`atob`.** Deno and `deno_core` both
   provide these on `globalThis` (part of WHATWG Encoding). Sanity-check in
   F-002: call `globalThis.btoa("x")` before loading `core.mjs`.
6. **`fetch` is required on `globalThis` for the shim wrapper to delegate
   data: URLs.** `deno_core` does not include `fetch` by default; it lives
   in the `deno_fetch` extension. For F-001's fixture we never hit a data:
   URL (no images in `basic-shapes`), so F-002 can probably ship without
   `deno_fetch` — but if a fixture with images comes in before full shim
   work, the Rust host will need to either register a minimal `fetch` op or
   mirror the data:-URL handling in Rust.
7. **Bundle size.** 3.3 MB minified is well under the the original implementation plan JS budget
   (1–4 MB) and adds only ~3–4 MB to the final binary after V8 does its
   thing. On track.
8. **Call convention.** F-002 should keep the `globalThis.__in.scene /
   opts` trampoline pattern suggested in the original implementation plan — our `__render`
   already accepts a string, so `serde_json::to_string(scene)` and
   stashing it is the clean path.

## Known weird things

- **Empty `<mask />` element in the output.** Upstream `scene/export.ts`
  always emits a `<mask>` node even for scenes with no masked elements.
  Not a bug we introduced. Browsers ignore empty `<mask>`.
- **`fetch` throws loudly for unexpected URLs.** The shim throws a clear
  error if a URL doesn't match `/fonts/`, `.woff2`, or `data:`. None fired
  for `basic-shapes`. If future fixtures (images, links) trigger it, the
  error message will point straight at `spike/shims.mjs`.
- **`platform=neutral` needs explicit `mainFields`.** Default `mainFields:
  []` under `platform=neutral` broke CJS resolution for `inherits`,
  `crc-32`, etc. the original implementation plan calls out `--platform=neutral`; J-010 needs to
  add `mainFields: ["browser", "module", "main"]` and
  `conditions: ["module", "import", "browser", "default"]` to match.
- **`stub-virtual:` inputs in metafile.** These are artifacts of esbuild's
  plugin namespace — they are stubs, not real source. The J-011 metafile
  audit script should skip any input path starting with `stub-virtual:`.
