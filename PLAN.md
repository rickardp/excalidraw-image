# excalidraw-image — Implementation Plan

A self-contained CLI that converts `.excalidraw` files to SVG (plain or
editable `.excalidraw.svg`) and, if feasible in v1, to PNG. Shipped as a
native per-platform binary via Homebrew + GitHub Releases + crates.io
(`cargo install`). No Node/Bun runtime required on the user's machine.

**v1 architecture: Rust shell + embedded `deno_core` (V8) running our
bundled JS.** Decided up front, not deferred. Rationale: deferring the
Rust host means every v1 design choice quietly encodes assumptions about
the v1 host (Bun-specific APIs, Bun embedded assets, Bun's fetch
behavior). Those assumptions surface as bugs during the migration, not
before. We'd rather find them by building the real thing now.

**Dev loop uses Deno** (not Bun) for fast JS iteration without recompiling
Rust. Deno and `deno_core` share the same V8 + ESM loader + module
resolution semantics, so "runs in Deno" is a near-perfect predictor of
"runs in our Rust shell." CI gate: for every fixture, the output of
`deno run src/core/dev.mjs` must byte-equal the output of
`cargo run --release`. Drift = host leak = blocked.

> **Naming.** If PNG is in scope, `excalidraw-image` reads better than
> `excalidraw-image`. Binary name is **tentatively `excalidraw-image`**,
> pending the Phase 0 decision on whether PNG ships in v1. If PNG slips to
> v1.1, we ship as `excalidraw-image` and rename in a future major. The crate,
> formula, and Homebrew tap all follow the binary name.

Upstream reference plan (verbatim inventory of the export path, DOM surface,
font assets, and subsetter): `/Users/rickard/oss/excalidraw/SVG_EXPORT.md`.
That document remains the source of truth for *what the JS code touches*;
this plan layers distribution, bundling, and the Rust/Bun split on top.

---

## 1. Goals & non-goals

**Goals (must-have)**

- `brew install rickardp/tap/excalidraw-image` installs a single native binary.
- GitHub Releases publishes tarballs for all supported platforms; the
  Homebrew formula pulls from those releases.
- No Node/Bun on the user's machine. No `--requires node ≥ 18`.
- Reads `.excalidraw`, writes `.svg` or `.excalidraw.svg` (editable,
  round-trippable on excalidraw.com).
- Tracks upstream Excalidraw by **consuming the published
  `@excalidraw/excalidraw` npm package** — no fork, no vendored source.
  Version bumps = dependency bump + generated asset-manifest refresh + CI
  snapshot refresh.

**Goals (nice-to-have)**

- `cargo install excalidraw-image` builds from source on user's machine
  (Rust path — secondary track, does not block v1).
- `cargo binstall excalidraw-image` shortcuts to the GitHub Release binary.
- SVG → PNG via `resvg` (Rust) / `@resvg/resvg-js` (WASM). Pure rasterization,
  no headless browser. Decision to include in v1 made in Phase 0.

**Non-goals for v1**

- `renderEmbeddables` (iframes, YouTube, video embeds).
- Font discovery from the OS; only bundled WOFF2s.
- `.excalidraw.png` as input (scene embedded in PNG metadata) — easy to add
  post-v1 since the codec is pure JS (`png-chunks-extract`).
- Live font downloads at runtime.
- Editor / UI / collaboration / clipboard.

**Open for v1 if cheap**

- PNG output via rasterization (likely trivial once SVG is stable).
- `.excalidraw.svg` as input (strip scene back out, or re-export).
- stdin input, batch/glob input.

---

## 2. Architecture

One deliverable, one build graph:

```
┌──────────────────────────────────────────────────────────────┐
│  JS core  (dist/core.mjs — Excalidraw export path + fonts)   │
│    - consumes @excalidraw/excalidraw from npm                │
│    - installs DOM/canvas/FontFace/fetch/base64 shims         │
│    - zero host APIs — no Bun.*, no Deno.*, no fs             │
│    - exposes: globalThis.__render(sceneJSON, opts)           │
│        → { svg, pngBase64? }                                 │
│    - runs identically under Deno (dev) and deno_core (ship)  │
└───────────────────────────┬──────────────────────────────────┘
                            │ include_str! at compile time
                            ▼
┌──────────────────────────────────────────────────────────────┐
│  Rust shell  (crates/excalidraw-image/)                      │
│    - argv parsing, file I/O, stdout/stderr                   │
│    - deno_core JsRuntime holds V8 + loads core.mjs           │
│    - JSON bridge: scene in → { svg, pngBase64 } out          │
│    - resvg crate for PNG (native, replaces any WASM path)    │
│    - one static binary per (os, arch)                        │
└───────────────────────────┬──────────────────────────────────┘
                            │ cargo build --release
                            ▼
┌──────────────────────────────────────────────────────────────┐
│  Distribution                                                │
│    - GitHub Releases: tarballs per platform (cross-compiled) │
│    - Homebrew tap: pulls from GH Releases                    │
│    - crates.io: `cargo install excalidraw-image` builds from │
│      source; `cargo binstall` pulls GH Release binary        │
└──────────────────────────────────────────────────────────────┘
```

**Why Rust + deno_core, not Bun compile:**

- One shipping artifact across Homebrew + GitHub Releases + crates.io.
- Native Rust libraries (`resvg`, `fontdb`) instead of WASM rasterizers.
- No fixed ~55 MB Bun runtime floor — V8 embedded via rusty_v8 lands
  smaller after LTO and strip. Expected ~40–50 MB.
- Finds host-portability bugs (fetch semantics, module resolution,
  absent Bun APIs) immediately, not during a v2 migration.
- Rust is the only of the options that supports `cargo install` as a
  first-class channel.

**Why `deno_core` over `rquickjs`:**

- V8 = full modern JS (TLA, dynamic import, private fields, native
  `Promise.withResolvers`, etc.) — Excalidraw uses all of these.
- rquickjs is smaller but has gaps in modern JS; we'd be fighting the
  engine instead of fighting the problem.
- `deno_core` is Deno's production runtime core — well-supported and
  well-tested. We are nowhere near its limits.

**Why Deno (not Node or Bun) for the dev loop:**

- Deno *is* `deno_core` + a runtime layer. Same V8, same ESM loader,
  same import resolution. If it runs in Deno, it runs in our shell.
- Node has CommonJS/ESM interop noise and a different module resolver.
- Bun has Bun-specific APIs that are easy to leak into JS code by
  accident. We want a dev host that fails closed on those.

**Why consume from npm instead of vendoring monorepo source:**

We cannot avoid bundling some Excalidraw code into a standalone binary, but we
can avoid owning and syncing that code. The dependency boundary is the published
`@excalidraw/excalidraw` package pinned in `package-lock.json` / `bun.lock`.

The build consumes:

- the package root export for `exportToSvg`;
- the installed package's `dist/prod/fonts/**/*.woff2` files as build-time
  assets;
- Excalidraw's own font registration and subsetter, reached through the public
  export path rather than a local reimplementation.

At runtime, Excalidraw still asks for its normal font URLs. Our `fetch` shim
serves those URLs from an embedded in-memory asset map, so there is no network
access and no copied source tree.

If the package root drags in too much React/editor code, the fallback is a
generated bundle from a pinned upstream checkout during build. That checkout is
not committed to this repo; it is a dependency input, similar to a source
tarball.

---

## 3. Phase 0 — Feasibility spike (2–3 days, blocks the rest)

Two parallel questions, both de-risked before we write any permanent code.

### 3.1 Spike: bundle `@excalidraw/excalidraw` with esbuild, run in Deno

```bash
mkdir spike && cd spike
npm init -y
npm i @excalidraw/excalidraw linkedom fontkit
```

`spike/entry.mjs`:

```js
import "./shims.mjs"; // linkedom, canvas, FontFace, btoa, fetch-fonts, worker-kill
import { exportToSvg } from "@excalidraw/excalidraw";

globalThis.__render = async (sceneJson) => {
  const scene = JSON.parse(sceneJson);
  const svg = await exportToSvg({
    elements: scene.elements,
    appState: scene.appState,
    files: scene.files ?? {},
  });
  return { svg: svg.outerHTML };
};

// dev entry only — the Rust host sets its own input path
if (globalThis.Deno) {
  const path = Deno.args[0];
  const input = await Deno.readTextFile(path);
  const { svg } = await globalThis.__render(input);
  console.log(svg);
}
```

Build:

```bash
esbuild entry.mjs --bundle --format=esm --platform=neutral \
  --outfile=core.mjs --metafile=meta.json
```

Note `--platform=neutral`: we target **no specific host**. The bundle must
run unchanged under Deno and `deno_core`. No `node:` specifiers, no `Bun.*`,
no `fs` imports in the JS.

**Accept if:**

- `deno run --allow-read spike/dev.mjs fixtures/basic.excalidraw` produces
  SVG that opens in excalidraw.com.
- esbuild metafile shows no React renderer/editor UI path in the hot bundle.
- Font export works offline by serving embedded WOFF2 bytes through the
  `fetch` shim.

**Reject if** the package root is too React/editor-coupled or cannot be made
to run under the shims → fall back to generated-source bundle from a pinned
upstream checkout. Do not vendor that checkout.

### 3.2 Spike: embed `core.mjs` in a Rust binary via `deno_core`

`spike-rust/Cargo.toml`:

```toml
[dependencies]
deno_core = "0.318"
serde_json = "1"
tokio = { version = "1", features = ["rt", "macros"] }
```

`spike-rust/src/main.rs`:

```rust
use deno_core::*;

#[tokio::main]
async fn main() -> Result<(), AnyError> {
    let mut rt = JsRuntime::new(RuntimeOptions::default());
    rt.execute_script("core.mjs", include_str!("../../spike/core.mjs"))?;

    let scene = std::fs::read_to_string(std::env::args().nth(1).unwrap())?;
    let call = format!("globalThis.__render({})", serde_json::to_string(&scene)?);
    let result = rt.execute_script("call.js", call)?;

    // Await the promise, then JSON.stringify the result on the JS side,
    // then extract as a Rust String.
    let result = rt.resolve_value(result).await?;
    let scope = &mut rt.handle_scope();
    let v = result.open(scope);
    // ...print .svg field
    Ok(())
}
```

**Accept if:**

- `cargo run --release -- fixtures/basic.excalidraw` produces byte-identical
  SVG to the Deno path in §3.1.
- Release binary < 60 MB stripped with LTO.
- Cold start < 400 ms for a trivial scene.

**Reject if** the bundle can't evaluate (module resolution, TLA handling,
missing ops). Most likely failure: Excalidraw uses `fetch` at a point we
didn't anticipate; our fix is to add a Rust op for `fetch` that routes to
the embedded asset map, or polyfill `fetch` entirely in the JS shim.

### 3.3 Decision point

Output of Phase 0: a one-pager deciding

1. Package-root bundle vs generated-source bundle for the JS core.
2. Whether PNG ships in v1 (resvg native) or v1.x.
3. The exact `deno_core` version to pin against.

Everything after Phase 0 assumes the decisions are made.

---

## 4. JS core bundle (`dist/core.mjs`)

Reference: upstream plan §3–§6 for the DOM/canvas/font shim details. They
apply unchanged. This section notes what's specific to running under
`deno_core` (and, for the dev loop, Deno).

**Portability contract** — the JS core must not reference:

- `Bun.*`, `Deno.*`, `process.*` (except `process.env` at build time, dead-
  coded via `--define`), `globalThis.Buffer`, `fs`, `path`, `node:*`.
- Any filesystem or network I/O. All bytes arrive via the JSON input or the
  embedded font table; all bytes leave via the return value.

A lint rule (`no-restricted-globals` + `no-restricted-imports` in eslint
config for `src/core/`) enforces this mechanically.

### 4.1 Entry

`src/core/index.mjs`:

```js
import "./shims/install.mjs"; // dom, base64, canvas, fonts, workers, fetch-fonts
import { exportToSvg } from "@excalidraw/excalidraw";

async function render(sceneJson, opts = {}) {
  const scene = typeof sceneJson === "string" ? JSON.parse(sceneJson) : sceneJson;
  const exportScale = computeExportScale(scene.elements, opts);

  const svgEl = await exportToSvg({
    elements: scene.elements,
    appState: {
      ...scene.appState,
      exportEmbedScene: !!opts.embedScene,
      exportScale,
    },
    files: scene.files ?? {},
    // forward opts.padding, opts.dark, opts.exportingFrame, …
  });

  return {
    svg: svgEl.outerHTML,
    // PNG is never rasterized in JS — the Rust host calls resvg directly
    // on the SVG string. This function only ever returns SVG.
  };
}

// The Rust shell calls this by string eval:
//   globalThis.__render(sceneJsonString, optsJsonString)
globalThis.__render = (sceneJson, optsJson) =>
  render(sceneJson, JSON.parse(optsJson ?? "{}"));
```

The JSON bridge is deliberate: **everything crossing the host boundary is
JSON-serializable strings or primitives.** No DOM nodes, no Buffer, no
Promises of DOM things. The Rust host awaits the promise with
`rt.resolve_value`, then pulls `.svg` off as a String.

### 4.1.1 Dev entry

`src/core/dev.mjs` — used only under Deno for the fast dev loop:

```js
import "./index.mjs"; // registers globalThis.__render

if (typeof Deno === "undefined") {
  throw new Error("dev.mjs is a Deno-only dev entry; production uses Rust shell");
}

const path = Deno.args[0];
if (!path) {
  console.error("usage: deno run --allow-read src/core/dev.mjs <input.excalidraw>");
  Deno.exit(1);
}

const sceneJson = await Deno.readTextFile(path);
const { svg } = await globalThis.__render(sceneJson);
console.log(svg);
```

This file is in the repo but not shipped. It exists only so CI can diff
`deno run dev.mjs fixture` against `cargo run -- fixture` and fail on
divergence.

### 4.2 Shims

- `shims/dom.mjs` — linkedom `window`/`document`.
- `shims/base64.mjs` — Buffer-backed `window.btoa`/`atob`.
- `shims/canvas.mjs` — `document.createElement("canvas")` → object with
  `getContext("2d") → { font, measureText }` routed to fontkit.
- `shims/fonts.mjs` — `FontFace` stub that preserves `family`, `style`,
  `weight`, `display`, and `unicodeRange`, plus a minimal `document.fonts`
  implementation for Excalidraw's checks.
- `shims/fetch-fonts.mjs` — intercepts Excalidraw font asset fetches and serves
  embedded WOFF2 bytes from `font-assets.mjs`; delegates all other fetches to
  the host.
- `shims/workers.mjs` — ensures `globalThis.Worker` is `undefined` **before**
  `@excalidraw/excalidraw/subset/subset-main.ts` loads (which captures
  `typeof Worker` at module evaluation). In the Rust+JS-engine path this is
  automatic (neither rquickjs nor deno_core defines `Worker` by default).
- `shims/device.mjs` — **F-001 discovery**: `devicePixelRatio` is read at
  module-eval time by Excalidraw's renderer chunk. Must be pre-installed
  on `globalThis` before the main entry loads (suggest `globalThis.devicePixelRatio = 1`).
  Defensive but small.
- `shims/web-globals.mjs` — **F-002 discovery**: `deno_core`'s default
  runtime does not provide many Web-platform globals that Deno does.
  Polyfills required: `URL`, `URLSearchParams`, `TextEncoder`, `TextDecoder`,
  `Event`, `EventTarget`, `DOMException`, `performance.now()`, `setTimeout`,
  `clearTimeout`, `setInterval`, `clearInterval`. Polyfill in JS (not via
  `deno_core` extensions) so Deno and `deno_core` hosts run identical code
  and the parity gate (R-007) stays meaningful. Cost: ~2–4 KB added to
  bundle.

Install order, enforced by `shims/install.mjs`:

```
device → web-globals → dom → base64 → fonts → fetch-fonts → canvas → workers
```

### 4.3 Font inlining

This is the area where prior attempts at Excalidraw-to-SVG CLIs have
stumbled. Treat it as a first-class subsystem with its own phase, its own
test suite, and explicit validation gates. See **§4A — Font engineering in
depth** below for the full breakdown.

Short version: we let Excalidraw's own `Fonts.generateFontFaceDeclarations()`
and subsetter generate the `<style class="style-fonts">` block. The CLI embeds
the installed npm package's WOFF2 assets and uses a `fetch` shim so Excalidraw
can load those assets offline. Tests assert the generated inventory matches the
installed `@excalidraw/excalidraw/dist/prod/fonts/` directory byte-for-byte.

### 4.4 `.excalidraw.svg` (editable) format

Unchanged from upstream plan §3.5. `exportToSvg` already produces the
`<metadata>` payload block when `appState.exportEmbedScene: true`. Our only
concern is that linkedom's serializer preserves the comment markers verbatim
— verified in Phase 5 with a round-trip test (decode with
`@excalidraw/excalidraw/data/encode`).

---

## 4A. Font engineering in depth

Prior attempts at this problem have failed most often on fonts. Symptoms
reported elsewhere:

- SVG renders with invisible / tofu text in browsers.
- Text wraps at different positions than the web app (content clips or
  overflows containers).
- `.excalidraw.svg` opens in excalidraw.com but fonts display wrong.
- Bundle size explodes when fonts aren't subsetted.
- CJK text appears as blocks because the Xiaolai fallback wasn't wired.
- Unicode-range `@font-face` shards get wrong ranges, browsers pick the
  wrong file for a given glyph.

This section treats each failure mode explicitly.

### 4A.1 What must be true for text to render correctly

Three independent things must all be right:

**1. Metrics parity** — the width `Excalidraw` assigns to a run of text during
export (via `measureText` / fontkit) must closely match what a browser will
compute when the SVG is later rendered. If metrics disagree, text breaks at
different column counts and either overflows its container (ugly) or is
clipped by a frame/container rect (broken).

**2. Glyph coverage** — every codepoint used in the scene must be reachable
in *some* embedded subsetted `@font-face` declaration. A glyph that resolves to
no embedded font falls back to system fonts, producing non-deterministic output.

**3. WOFF2 round-trip integrity** — when we subset the WOFF2 (decode → subset
→ re-encode), the output must be parseable by browsers and must preserve
horizontal metrics, glyph outlines, and unicode tables. A botched subset
produces silent rendering failures.

All three can and have gone wrong independently. We plan to verify each
with a dedicated test class.

### 4A.2 Metrics: fontkit vs browser `measureText`

Upstream Excalidraw calls `setCustomTextMetricsProvider` (used by
`getLineWidth`) *and* directly uses `canvas.measureText` in `scene/export.ts`
for frame-label truncation. Both paths must converge on the same fontkit
measurements — our canvas shim routes `measureText` through the same
`FontkitTextMetricsProvider` instance.

Known divergence between fontkit and Chrome `measureText`:

- **Tabular digit subtleties**: Nunito has OpenType features that browsers
  may enable by default; fontkit only applies shaping for explicitly
  requested features. For Latin text this is usually ≤1 px per glyph.
- **Emoji**: fontkit correctly handles ligatures and variant selectors on
  color-emoji fonts. Since we don't bundle an emoji font, emoji falls
  through to system and divergence is unbounded. **This is documented**,
  not fixed.
- **CJK**: Xiaolai is a display font; fontkit handles it correctly. Chrome
  may add ideographic space treatments; measured divergence is small.

Validation gate (phase 2): build a test scene with known-hard inputs
(mixed-script paragraph wrapping at container width 300 px). Export via
the CLI. Also export via `excalidraw.com` manually, or via a
vitest/jsdom-based oracle. Assert line-break columns match **exactly** or
within ±1 char per line for every line. If mismatches > 1 char, invest
in fontkit feature configuration before moving on.

### 4A.3 Subsetting: use Excalidraw's bundled pipeline

The upstream subset path in `packages/excalidraw/subset/subset-shared.chunk.ts`
is bundled into the published package. We do not call it directly; we let
`exportToSvg()` call `Fonts.generateFontFaceDeclarations()`, which eventually
uses this pipeline:

```
WOFF2 bytes
  → wawoff2.decompress()      → TTF bytes
  → fonteditor-core.TTF.parse → Font object
  → font.subset(codepoints)   → subset Font
  → font.write("ttf")         → TTF bytes
  → wawoff2.compress()        → WOFF2 bytes
  → base64                    → data: URL in @font-face
```

Every step has a known failure mode:

| Step | Failure | Mitigation |
|---|---|---|
| `wawoff2.decompress` | Hangs on malformed WOFF2. | We control the input (embedded npm-package assets). Unit test that each WOFF2 can be fetched through the shim and subset by Excalidraw. |
| `fonteditor-core.TTF.parse` | Silent parse errors → returns a Font missing tables (`hmtx`, `cmap`). | Covered by the Excalidraw-generated subset round-trip tests. |
| `font.subset(codepoints)` | Subsetter drops the `.notdef` glyph → browsers reject the font. Or drops composite glyph components. | Test: export a known text scene, render the result in a real browser via Playwright; assert glyphs appear. |
| `font.write("ttf")` | Produces TTF bytes without valid `head.checkSumAdjustment` in some fonteditor-core versions. | Pin the Excalidraw package version; only upgrade with fixture + browser tests. |
| `wawoff2.compress` | Large fonts (Xiaolai shards) take 100+ ms each. | Let Excalidraw's own implementation do the work; add a per-invocation fetch/subset cache only if profiling says it matters. |
| base64 → data: URL | `data:font/woff2;base64,...` must have correct MIME; Chrome is strict. | Fixed string, covered by unit test. |

We do **not** patch or reimplement the subset pipeline. We provide bytes through
`fetch()` and test the resulting SVG.

### 4A.4 Unicode-range sharding and `@font-face` generation

Excalifont, Nunito, ComicShanns, and Xiaolai ship as **multiple WOFF2 files**
each, split by Unicode range. Excalidraw's current implementation uses each
font face's `unicodeRange` descriptor internally to decide which shards to
subset for a scene.

Upstream stores the ranges in each font's descriptor and bundles those
descriptors into `@excalidraw/excalidraw`. We consume them indirectly by using
Excalidraw's own `Fonts.generateFontFaceDeclarations()` path. We do not
re-derive ranges and `font-assets.mjs` does not encode family semantics; it is
only a path-to-bytes map.

After subsetting, Excalidraw emits one `@font-face` per contributing shard.
Current upstream CSS does **not** include the original `unicode-range`; the
range was already used to select the shard before subsetting:

```css
@font-face {
  font-family: "Excalifont";
  src: url(data:font/woff2;base64,...);
}
```

Because the emitted CSS lacks `unicode-range`, the browser-fidelity tests are
important: they must prove that multiple subsetted faces for the same family
still render the expected glyphs in real browsers.

### 4A.5 Fallback order and family aliasing

Scene elements store a numeric `fontFamily` ID. Upstream's mapping
(`fonts/index.ts`) resolves IDs to family names in a CSS fallback list like:

```
"Excalifont, Xiaolai, Segoe UI Emoji"
```

Three behaviors the CLI must preserve:

1. **Xiaolai as CJK fallback** — emitted `font-family` on the `<text>`
   element keeps `Xiaolai` in the fallback list so CJK glyphs resolve.
2. **Segoe UI Emoji** — kept in the list as a best-effort name. Not
   bundled. If the viewer's system has it, emoji renders; otherwise, tofu.
3. **Helvetica → Liberation Sans** — rendered via bundled Liberation Sans
   (same metrics), but the `font-family` string on the SVG keeps
   `Helvetica` if that's what the scene requested, so the editable payload
   round-trips correctly.

Family aliasing for **unknown** families:

- Default: render with Excalifont (the scene's visual default).
- `--strict-fonts`: exit non-zero with a list of offending families.

### 4A.6 The `local:` descriptor trap

`Emoji/` and `Helvetica/` directories in upstream have **no WOFF2** — only
descriptors that declare `src: local(...)`. Browser Excalidraw resolves
these at runtime against the user's system fonts.

On the CLI, we have no system font access and no WOFF2 to subset. Behavior:

- The family name is preserved in the SVG's `font-family` CSS string.
- No `@font-face` is emitted for the family.
- Measurement falls back to the closest bundled family (Liberation for
  Helvetica; Excalifont for Emoji).
- This is an explicit, documented limitation; `--strict-fonts` flags it.

### 4A.7 Font storage in the binary

Option A: fonts embedded as base64 into `core.mjs` at build time — works
identically for Bun and Rust hosts, no runtime filesystem. Current Excalidraw
WOFF2 assets are about 12.5 MB raw and about 16.7 MB base64 before JS overhead.

Option B: fonts shipped alongside the binary (`dist/fonts/*.woff2`), read
via `Bun.embeddedFiles` or `include_bytes!`. Smaller JS bundle, but
requires different read paths per host.

**Decision: Option A.** Single source of truth, simplifies Rust integration
(no file I/O from JS side), and the size cost is negligible relative to
the ~60 MB V8/Bun runtime.

### 4A.8 Validation gates for the font subsystem

Phase 3 does not complete until all of these pass:

1. **Inventory test**: `font-assets.mjs` entries are byte-exact against the
   installed `@excalidraw/excalidraw/dist/prod/fonts/` tree. Dep bump that
   touches a WOFF2 fails CI with a diff.
2. **Subset round-trip test** per family: export a text fixture through
   Excalidraw's own font path; decode the embedded data URL; assert
   `hmtx`/`cmap`/`glyf` tables are present and the glyphs render.
3. **Browser fidelity test** (Playwright, runs in CI): for each supported
   family, render a known string via the CLI, load the SVG in headless
   Chrome, extract computed text width, compare to a baseline measured in
   a real browser with the unmodified Excalidraw app. Tolerance: ≤2 px
   per 100-char string.
4. **Mixed-script fixture**: Latin + CJK + emoji in one text element.
   Assert (a) no tofu in Latin or CJK, (b) the output includes the expected
   subsetted data-URL faces for the participating families, (c) emoji renders
   as tofu *only* when tested on a system without Segoe UI Emoji (documented
   expectation).
5. **Wrap-parity fixture**: a 400-char paragraph wrapped at 300 px
   container width. CLI output and browser-rendered output must agree on
   line-break columns within ±1 per line. Regression test locks in the
   baseline.
6. **`.excalidraw.svg` round-trip**: export with `--embed-scene`, re-open
   on excalidraw.com (manual sanity) *and* decode the payload in a unit
   test; font metadata (family name, fallback order) in the round-tripped
   scene must exactly equal the input.

Miss any gate → font work is not done, regardless of how "mostly right"
the output looks.

### 4A.9 Escape hatches we deliberately avoid

- Re-implementing the subsetter in Rust (via `woff2`, `ttf-parser`,
  `subsetter` crates). This was considered. **Rejected** because it
  introduces a second code path that can diverge from upstream's subset
  output. One of the prior-attempt failure modes was exactly this —
  "Rust subsetter produces a slightly different WOFF2, and some scenes
  render differently than the web app." We defer to `wawoff2` +
  `fonteditor-core` for v1.

- Shipping unsubsetted WOFF2s. Blows up SVG size by 10–100× for text-light
  scenes. Rejected.

- Using `@napi-rs/canvas` for real canvas metrics. Adds a platform-specific
  native binary, which breaks the "single Bun binary" model. fontkit
  suffices for our needs.

- Fetching fonts from a CDN at runtime. Breaks "no network at runtime" and
  adds a failure mode we can't test offline. Rejected.

---

### 4.5 Rasterization (PNG, optional)

PNG is **not** rasterized in JS. The JS core returns SVG only; the Rust
shell hands that SVG to the native `resvg` crate with the same font
database the JS bundle embeds. See §5.5 for the implementation.

---

## 5. Rust shell (`excalidraw-image` binary)

Single binary. One codebase. Shipped via Homebrew + GitHub Releases, and
publishable to crates.io so `cargo install` works from day one.

### 5.1 Crate layout

```
crates/excalidraw-image/
  Cargo.toml
  build.rs              # copies dist/core.mjs into OUT_DIR for include_str!
  src/
    main.rs             # argv, file I/O, stdout
    engine.rs           # deno_core wrapper
    raster.rs           # resvg path for PNG (behind --format png)
    ops.rs              # deno_core extension ops (e.g. host-side panic bridge)
    argv.rs
```

### 5.2 Engine

```rust
// engine.rs
use deno_core::{JsRuntime, RuntimeOptions, serde_v8, v8};
use serde::Deserialize;

#[derive(Deserialize)]
pub struct RenderResult {
    pub svg: String,
}

pub struct Engine { rt: JsRuntime }

impl Engine {
    pub fn new() -> Self {
        let mut rt = JsRuntime::new(RuntimeOptions::default());

        // Classic-script eval of the pre-bundled core.mjs. F-002 discovered
        // load_main_es_module_from_code swallows synchronous throws; classic
        // script surfaces errors immediately. J-010 strips `import.meta.*`
        // via esbuild --define so nothing in the bundle references it.
        rt.execute_script("core.mjs", include_str!(concat!(
            env!("OUT_DIR"), "/core.mjs"
        ))).expect("core.mjs failed to load");

        Self { rt }
    }

    pub async fn render(&mut self, scene: &str, opts: &str)
        -> anyhow::Result<RenderResult>
    {
        // Trampoline: stash inputs as globals so we don't JSON-escape a
        // multi-megabyte scene into a script literal.
        let setup = format!(
            "globalThis.__in = {{ scene: {}, opts: {} }}",
            serde_json::to_string(scene)?,
            serde_json::to_string(opts)?,
        );
        self.rt.execute_script("setup.js", setup)?;

        let promise = self.rt.execute_script(
            "call.js",
            "globalThis.__render(globalThis.__in.scene, globalThis.__in.opts)",
        )?;

        // deno_core 0.399: resolve_value deprecated. Use resolve + await.
        let resolved = self.rt.resolve(promise);
        let resolved = self.rt.with_event_loop_promise(resolved, Default::default()).await?;

        // handle_scope method gone; use the scope! macro.
        deno_core::scope!(scope, &mut self.rt);
        let local = v8::Local::new(scope, resolved);
        Ok(deno_core::serde_v8::from_v8(scope, local)?)
    }
}
```

Notes:

- **Classic-script eval, not ES modules.** F-002 finding: the ES-module
  loader silently swallows synchronous throws. Classic-script eval is
  safer. Requires esbuild to strip `import.meta.*` via `--define`.
- No custom `module_loader`: the bundle is self-contained, no imports
  at runtime. If esbuild leaks an unresolved import, build fails fast.
- All I/O lives on the Rust side. JS never touches the filesystem.
- No `op` bindings in v1 — string-eval + JSON bridge is enough.
- **deno_core 0.399.0 pinned** (PHASE0.md §2). `serde_v8` is re-exported.

### 5.3 `main.rs` — argv + I/O

```rust
use std::io::{Read, Write};

#[tokio::main(flavor = "current_thread")]
async fn main() -> anyhow::Result<()> {
    let args = argv::parse(std::env::args_os())?;

    let mut scene = String::new();
    match args.input.as_str() {
        "-" => std::io::stdin().read_to_string(&mut scene)?,
        path => scene = std::fs::read_to_string(path)?,
    };

    let mut engine = engine::Engine::new();
    let result = engine.render(&scene, &args.opts_json()).await?;

    let bytes: Vec<u8> = match args.format {
        Format::Svg => result.svg.into_bytes(),
        Format::Png => raster::svg_to_png(&result.svg, &args)?,
    };

    match args.output.as_str() {
        "-" => std::io::stdout().write_all(&bytes)?,
        path => std::fs::write(path, bytes)?,
    }
    Ok(())
}
```

### 5.4 CLI surface

```
excalidraw-image <input> [options]

Inputs:
  <input>                   Path to .excalidraw or .excalidraw.svg. Use "-" for stdin.

Outputs:
  -o, --output <file>       "-" for stdout. Default: stdout.
      --format <svg|png>    Default: inferred from --output extension, else svg.
      --embed-scene         Emit editable .excalidraw.svg with scene metadata.

Rendering:
      --no-background       Omit background rect.
      --dark                Dark-mode filter.
      --padding <n>         Default 10.
      --scale <n>           Default 1.
      --frame <name|id>     Export only that frame.
      --max <n>             Clamp to max width or height.

Fonts:
      --skip-font-inline    Don't embed @font-face. Browsers must have fonts.
      --strict-fonts        Error instead of mapping unknown families to Excalifont.

  -h, --help
  -v, --version
```

### 5.5 PNG via native `resvg`

```rust
// raster.rs
use resvg::{tiny_skia, usvg};

pub fn svg_to_png(svg: &str, args: &Args) -> anyhow::Result<Vec<u8>> {
    let mut fontdb = usvg::fontdb::Database::new();
    for (family, bytes) in EMBEDDED_FONTS.iter() {
        fontdb.load_font_data(bytes.to_vec());
    }

    let tree = usvg::Tree::from_str(svg, &usvg::Options {
        fontdb: std::sync::Arc::new(fontdb),
        ..Default::default()
    })?;

    let size = tree.size().to_int_size();
    let mut pixmap = tiny_skia::Pixmap::new(size.width(), size.height())
        .ok_or(anyhow::anyhow!("pixmap alloc failed"))?;
    resvg::render(&tree, tiny_skia::Transform::default(), &mut pixmap.as_mut());
    Ok(pixmap.encode_png()?)
}
```

`EMBEDDED_FONTS` is a `build.rs`-generated static table of `(family, &'static [u8])`
pairs derived from `node_modules/@excalidraw/excalidraw/dist/prod/fonts/`.
Same bytes the JS side uses, avoiding drift.

Key property: **PNG is pure Rust, no V8 touch.** The JS engine only ever
produces SVG strings. Rasterization happens entirely in `resvg` with the
same font database the JS side embeds. Faster than a WASM rasterizer and
doesn't force `resvg-js` into the JS bundle.

### 5.6 Binary size budget

| Component | Size | Notes |
|---|---:|---|
| `deno_core` + `rusty_v8` static + V8 snapshot | ~30–35 MB | Dominant. |
| `core.mjs` (Excalidraw + shims, minified) | 1–4 MB | Tree-shaking (§5.7) matters. |
| Embedded WOFF2s (static, raw bytes) | ~5 MB | Raw is smaller than base64. |
| `resvg` + `usvg` + `fontdb` | ~6 MB | Only if PNG in v1. |
| Misc (`tokio`, `serde_json`, `serde_v8`, `anyhow`, argv) | ~2 MB | |
| **Baseline (SVG only)** | **~42 MB** | |
| **Baseline (SVG + PNG)** | **~48 MB** | |
| **After LTO + `strip`** | **~35–40 MB** | Release profile below. |

`Cargo.toml` release profile:

```toml
[profile.release]
lto = "fat"
codegen-units = 1
strip = "symbols"
panic = "abort"
opt-level = "z"   # or "s" — pick in Phase 0 based on cold-start impact
```

No UPX. `deno_core` binaries are already reasonably sized, and Rust binaries
compress poorly relative to Bun bundles (more structured code, less
repetitive). Signing and notarization stay straightforward.

### 5.7 Tree-shaking the JS bundle (same as before, still critical)

Importing `@excalidraw/excalidraw` from the package root pulls the React
editor by default. Mitigations, in order of leverage:

1. **Import only what we need.** If Phase 0 finds a deep sub-path in the
   dist that exposes `exportToSvg` cleanly, use that. Otherwise, use the
   package root and rely on steps 2–4.
2. **Stub React and the editor at bundle time** via esbuild aliases.
   **F-001 finding: the PLAN's original alias list is necessary but not
   sufficient.** The actual list that survived the spike:
   ```js
   alias: {
     "react":                           "./stubs/proxy.mjs",
     "react-dom":                       "./stubs/proxy.mjs",
     "react-dom/client":                "./stubs/proxy.mjs",
     "react/jsx-runtime":               "./stubs/proxy.mjs",
     "react/jsx-dev-runtime":           "./stubs/proxy.mjs",
     "jotai":                           "./stubs/proxy.mjs",
     "jotai-scope":                     "./stubs/proxy.mjs",
     "@excalidraw/mermaid-to-excalidraw":"./stubs/proxy.mjs",
   },
   // Catch-all for the Radix family (wildcard not supported by alias;
   // use an esbuild plugin to resolve `^@radix-ui/` → stubs/proxy.mjs).
   loader: { ".css": "empty" },
   ```
   The stub must be a **callable `Proxy`**, not `{}` or `noop`. Downstream
   code uses `Object.assign(imported, {...})` and destructuring on imported
   symbols; a plain object breaks both. See `spike/README.md` for the
   working Proxy implementation.

   Additionally, **mark the 54 `dist/prod/locales/*.js` dynamic imports
   as external** (or alias to `proxy.mjs`). They're loaded via dynamic
   import inside Excalidraw's i18n code path and survive static
   tree-shaking; excluding them saves ~1.7 MB.
3. **esbuild flags for maximum dead-code elimination**:
   ```
   --minify
   --tree-shaking=true
   --legal-comments=none
   --drop:console,debugger
   --define:process.env.NODE_ENV='"production"'
   --define:import.meta.env.DEV='false'
   --define:import.meta.env.PROD='true'
   ```
4. **Metafile audit as a CI gate.** Fail the build if any of these paths
   show up in `meta.json`:
   - `**/components/App.tsx`, `**/components/LayerUI.tsx`
   - `**/actions/**`, `**/hooks/**`, `**/i18n.ts`, `**/locales/**`,
     `**/css/**`
   This is the guarantee; bundle size is the proxy.

### 5.8 Homebrew tap (in-repo, Pattern A)

The formula ships from this repo's own `Formula/excalidraw-image.rb`,
rendered by the release workflow from `.github/templates/excalidraw-image.rb.tmpl`
on each tag push. Users tap with the explicit URL form:

```
brew tap rickardp/excalidraw-image https://github.com/rickardp/excalidraw-image.git
brew install excalidraw-image
```

Maintenance benefit: one repo instead of two; no `HOMEBREW_TAP_TOKEN`
secret needed (the bump uses the built-in `GITHUB_TOKEN`). Rendered formula:

```rb
class ExcalidrawImage < Formula
  desc "Convert Excalidraw files to SVG/PNG"
  homepage "https://github.com/rickardp/excalidraw-image"
  version "0.1.0"

  on_macos do
    on_arm do
      url "https://github.com/rickardp/excalidraw-image/releases/download/v0.1.0/excalidraw-image-darwin-arm64.tar.gz"
      sha256 "..."
    end
    on_intel do
      url "..."; sha256 "..."
    end
  end

  on_linux do
    on_intel  { url "..."; sha256 "..." }
    on_arm    { url "..."; sha256 "..." }
  end

  def install
    bin.install "excalidraw-image"
  end

  test do
    assert_match "<svg", shell_output("#{bin}/excalidraw-image #{test_fixtures("basic.excalidraw")}")
  end
end
```

### 5.9 crates.io publishing

`cargo publish` works as long as:

- Build output (`dist/core.mjs`, embedded fonts) is produced by `build.rs`
  or checked into the crate's `assets/`.
- The crate is self-contained: no reference to files outside `crates/excalidraw-image/`.

Path (see §7 for the directory layout): `build.rs` hard-copies
`dist/core.mjs` + font bytes from the repo's top-level build output into
`OUT_DIR`. For `cargo publish`, we also commit a mirrored copy into
`crates/excalidraw-image/assets/` so the published crate compiles without
needing the surrounding workspace's JS toolchain.

```
cargo install excalidraw-image        # compiles locally from crates.io
cargo binstall excalidraw-image       # pulls the GH Release tarball
```

### 5.10 What we considered and rejected

- **Bun compile.** Ruled out: can't `cargo install` a Bun binary; every v1
  design choice would quietly encode Bun-specific assumptions.
- **`pkg` (Node), Node SEA, `deno compile`.** Same problem as Bun in
  different wrappers. All ship their own JS runtime and preclude the
  `cargo install` channel.
- **rquickjs instead of deno_core.** Smaller (~5 MB vs ~30 MB) but
  incomplete modern JS support. Excalidraw uses TLA, dynamic imports,
  private fields, and `Promise.withResolvers` — betting on rquickjs is
  betting on fighting engine gaps. Revisit only if binary size becomes
  the #1 blocker.
- **`resvg-js` (WASM) for PNG.** Works, but doubles the rasterizer code
  path (WASM inside V8 for PNG, native resvg unused). Native resvg is
  faster and removes ~2 MB of WASM from the JS bundle.
- **Native Rust port of `exportToSvg`.** 4–8 weeks of work and permanent
  divergence risk. Skip unless we hit a wall.

---

## 7. Repository layout

```
excalidraw-image/
  PLAN.md                           # this file
  SVG_EXPORT.md                     # upstream reference plan (kept in sync)
  README.md
  LICENSE                           # MIT
  package.json                      # pins @excalidraw/excalidraw + JS deps
  Cargo.toml                        # workspace root
  tsconfig.json
  deno.json                         # lockfile for the Deno dev loop
  Makefile

  src/
    core/                           # JS bundle source (host-neutral)
      index.mjs                     # exposes globalThis.__render
      dev.mjs                       # Deno-only dev entry
      font-assets.mjs               # generated path → base64 WOFF2 map
      shims/
        install.mjs
        dom.mjs
        canvas.mjs
        fonts.mjs
        fetch-fonts.mjs
        base64.mjs
        workers.mjs
      text-metrics.mjs              # FontkitTextMetricsProvider
    scripts/
      build-core.mjs                # esbuild → dist/core.mjs
      build-font-assets.mjs         # scans npm fonts dir → font-assets.mjs
      metafile-audit.mjs            # CI gate: forbidden imports in bundle

  crates/
    excalidraw-image/               # the one shipping binary
      Cargo.toml
      build.rs                      # copies dist/core.mjs + fonts → OUT_DIR
      src/
        main.rs                     # argv + file I/O
        engine.rs                   # deno_core wrapper
        raster.rs                   # resvg PNG path
        ops.rs                      # deno_core extension (reserved for v1.x)
        argv.rs
      assets/                       # checked-in mirror for cargo publish
        core.mjs
        fonts/

  tests/
    fixtures/
      basic-shapes.excalidraw
      text-wrapped.excalidraw
      frames.excalidraw
      cjk.excalidraw
      image.excalidraw
      emoji.excalidraw
      all-fonts.excalidraw
    js/                             # vitest, Node env (shims only)
      shims.test.mjs
    deno/                           # Deno dev-path smoke tests
      render.test.mjs               # uses src/core/dev.mjs
      roundtrip.test.mjs
    rust/                           # cargo test (integration)
      smoke.rs
      parity.rs                     # Deno vs Rust output byte-diff gate

  dist/                             # build output (gitignored)
    core.mjs                        # esbuild output, host-neutral
    bin/
      excalidraw-image-darwin-arm64
      excalidraw-image-darwin-x64
      excalidraw-image-linux-x64
      excalidraw-image-linux-arm64
      excalidraw-image-windows-x64.exe

  .github/workflows/
    release.yml                     # matrix cross-build + GH release + tap PR
    test.yml                        # CI on PR: deno vs rust parity gate
```

---

## 8. Build & release pipeline

### 8.1 Local dev

```
make bootstrap      # npm ci + cargo fetch
make core           # → dist/core.mjs (esbuild bundle, host-neutral)
make fonts          # → src/core/font-assets.mjs (regen from npm dir)
make dev            # deno run src/core/dev.mjs tests/fixtures/basic.excalidraw
make rust           # → target/release/excalidraw-image
make parity         # diff deno vs rust output on every fixture
make test           # js unit + cargo test + parity + fixture smoke-tests
```

The two fast loops are `make dev` (seconds) for JS-only iteration and
`cargo run` (seconds after the first full build) for end-to-end. `make parity`
is the safety net: any fixture where Deno and Rust disagree is a host leak
and a hard CI fail.

### 8.2 CI (GitHub Actions)

- `test.yml`: on PR, matrix (ubuntu-latest, macos-14, windows-latest):
  1. `deno run` fixture suite → golden SVGs.
  2. `cargo test` including `parity.rs` which spawns Deno on each fixture
     and byte-diffs against Rust output. This is the migration-safety gate.
  3. esbuild metafile audit (forbidden imports).
- `release.yml`: on tag push `v*`:
  1. Build `dist/core.mjs`.
  2. Matrix-build Rust binaries for all 5 platforms via
     `cargo build --release --target=<triple>`. Cross-compile from a single
     runner where feasible (`cross` crate) or per-OS runners for macOS +
     Windows.
  3. Sign/notarize macOS binaries (skip if no cert secret).
  4. Upload tarballs to GH release.
  5. `cargo publish` to crates.io (manual approval gate).
  6. Bump in-repo `Formula/excalidraw-image.rb` and commit to `main` (Pattern A).

### 8.3 Versioning

- Semver for our CLI.
- `EXCALIDRAW_VERSION` embedded at build time from `package.json`, surfaced
  by `excalidraw-image --version` (`excalidraw-image 0.1.0 (excalidraw 0.18.0, deno_core 0.318.0)`).
- Upstream excalidraw updates: bump `@excalidraw/excalidraw` in `package.json`,
  regenerate the embedded font asset map, run parity + fixture suite, ship
  patch or minor depending on output drift.

---

## 9. Phased implementation

v1 is Rust + `deno_core` from day one. No Bun. No separate v2 migration.

| Phase | Scope | Days |
|---|---|---:|
| **0** | Feasibility spike (§3): package-root bundle runs in Deno; `deno_core` runs it in Rust with byte-identical output | 2–3 |
| **1** | JS core minimal happy path — shims + `__render` for basic shapes, no text. Runs under both Deno and `deno_core`. | 1 |
| **2** | Text: fontkit provider + canvas shim + line-wrap parity (§4A.2) | 2 |
| **3** | **Fonts (§4A):** inventory, subsetting, inline `<style>`, all six validation gates (§4A.8) | **3–4** |
| **4** | Images + frames + clipping | 1 |
| **5** | `--embed-scene` round-trip test | 0.5 |
| **6** | Rust shell: argv, file I/O, engine wrapper, `main.rs`, parity CI gate | 1.5 |
| **7** | PNG via native `resvg` + embedded fontdb | 1 |
| **8** | Cross-compile matrix (5 platforms) + binary size audit + LTO tuning | 1 |
| **9** | Homebrew tap + GH Release workflow (signing, tarballs) + `cargo publish` | 1.5 |
| **10** | Docs, fixture-snapshot golden baseline, README | 1 |

**v1 total: ~15–17 working days.** PNG is in v1 because once the Rust shell
exists, `resvg` is nearly free (it's already in the Rust ecosystem, no
WASM).

**Font phase is the schedule risk.** Phase 3 is budgeted at 3–4 days rather
than the upstream plan's 1–2 because prior attempts hit walls here (§4A).
If Phase 3 slips, everything else waits — text is on the critical path, and
we will not ship with unresolved validation-gate failures.

**Host-portability discipline (now enforced by the architecture, not by
discipline alone):** the Rust shell is built from phase 6 onward, so from
that point forward any JS code that accidentally depends on Bun or Node
APIs fails CI immediately (the parity gate diffs Deno vs Rust output
byte-for-byte). There is no "works in dev, breaks in prod" window.

**Order rationale**: phases 1–5 are pure JS and can be developed entirely
under Deno (fast feedback loop). Phase 6 stands up the Rust side; from then
on, the parity gate is active and we never regress on host neutrality.

---

## 10. Testing strategy

Three layers, in order of increasing integration:

1. **JS unit** (vitest, node env, not jsdom) — per-shim correctness, `render()`
   output for each fixture. Run against raw JS core, not bundled.
2. **Bundle smoke** — load `dist/core.mjs` via `node --input-type=module` and
   run the fixture suite. Catches bundler regressions (missing assets, wrong
   shim order, tree-shake too aggressive).
3. **Binary smoke** — spawn the Bun binary and the Rust binary on the same
   fixture set, diff outputs against each other *and* against golden SVG.

Golden SVGs are **our own**, not the web app's — we don't target byte
parity with excalidraw.com. The acceptance test is: "opens in excalidraw.com
as `.excalidraw.svg`, round-trips cleanly" (decoded scene deep-equals input,
modulo `source` field).

Per-family font fixture: one fixture covers every supported family, asserts
each `@font-face` declaration lands in the output `<defs>` with a
non-empty base64 src.

---

## 11. Open risks

1. **Fonts — the one that has killed prior attempts.** See §4A for the full
   breakdown. Three independent failure modes (metrics divergence, missing
   font shards, subset round-trip corruption) each require their
   own validation gate. Phase 3 will not complete until all six gates in
   §4A.8 pass. Schedule risk is concentrated here.

2. **Package-root bundle bloat.** `@excalidraw/excalidraw` may pull React,
   editor UI, `browser-fs-access`, clipboard paths, and other browser-only code
   via dist tree-shaking failure. Phase 0 measures this; fallback is a
   generated-source bundle from a pinned upstream checkout.

3. **deno_core / rquickjs JS compatibility.** Our core bundle uses modern JS
   (TLA, dynamic imports, private fields). rquickjs has gaps; deno_core is
   safer but heavier. Phase 0.3 picks one empirically. Only relevant if
   Rust path is in v1.

4. **Bun binary size + macOS signing.** 60–80 MB is large for Homebrew
   users but normal for embedded-runtime CLIs (Deno compile is similar).
   macOS without notarization triggers Gatekeeper warnings. Workable but
   documented.

5. **Font licensing for redistribution.** Confirm per-family that bundled
   WOFF2s may be redistributed under MIT + our attribution. Upstream already
   ships them on npm, so this should be clean, but verify before v1.

6. **linkedom `<metadata>` serialization.** The `.excalidraw.svg` payload
   regex requires comments survive serialization verbatim. Upstream plan
   flagged this; Phase 5 round-trip test catches it. Fallback is a hand-
   written `<metadata>` string injected post-serialization.

7. **Bun's `--compile` FFI for native modules.** If we ever need a native
   module inside the Bun path (e.g., Node-canvas), `bun build --compile` may
   fail to bundle it. We don't today — fontkit and resvg-js are pure JS/WASM.
   Stay pure-JS on the Bun side.

8. **Upstream drift during v1 development.** Pin a specific
   `@excalidraw/excalidraw` version in `package.json` and don't bump until
   after v1 ships. CI re-runs fixtures weekly against latest upstream to flag
   drift early.

---

## 12. Decisions locked vs still open

**Locked (from interview):**

- v1 shell: **Rust + `deno_core`**, single binary. Not deferred.
- Distribution channels for v1: **Homebrew tap + GitHub Releases + crates.io**
  (`cargo install`). `cargo binstall` is a freebie off the same Releases.
- Dev loop: **Deno**, not Bun or Node. Same V8 + ESM semantics as `deno_core`.
- CI parity gate: Deno and Rust outputs must byte-equal on every fixture.
- Consumption: attempt package-root npm bundle; fall back to generated-source
  bundle from a pinned upstream checkout if needed.
- SVG in v1 required; `.excalidraw.svg` embed required; **PNG in v1 via
  native `resvg`** (cheap once the Rust shell exists).
- No Node/Bun runtime on user's machine.
- **Font work is first-class** (§4A) with dedicated validation gates.
  Budgeted at 3–4 days, on the critical path.
- Binary name: `excalidraw-image` (PNG is in v1, so the name fits).
- Host-neutral JS: lint enforces no `Bun.*`, `Deno.*`, `process.*`, `fs`,
  `node:*` in `src/core/`. Dev entry (`dev.mjs`) is exempted and lives
  outside the bundled graph.

**Still to decide (Phase 0 outputs):**

- Package-root bundle vs generated-source bundle — feasibility test decides.
- macOS codesigning (need Apple dev cert or accept Gatekeeper warning).
- `deno_core` version pin — pick the latest stable that supports our V8
  snapshot needs.
- `opt-level = "z"` vs `"s"` — pick based on Phase 0 cold-start measurement.

**Deferred to v1.x / later:**

- `.excalidraw.png` input.
- Watch mode / daemon / HTTP server.
- Batch input / glob.
- Custom font loading from disk.
- V8 snapshot at build time (startup-time optimization; only if we measure
  a cold-start problem).
- rquickjs as an alternative engine (only if binary size becomes the #1
  adoption blocker and a port test proves it works).
