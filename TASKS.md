# TASKS

Implementation punch list for `excalidraw-image`. The authoritative design
is in `PLAN.md`; this file is the execution backlog. Agents should pick a
task whose `deps` are all `done`, mark it `wip`, complete it, then mark
`done`. Do not invent tasks — if something is missing, append it at the
end with the next free ID and leave status `todo`.

## Status legend

| Status    | Meaning |
|-----------|---------|
| `todo`    | Ready. All deps done. |
| `blocked` | Deps not done. Don't pick up. |
| `wip`     | An agent is currently working on this. |
| `done`    | Complete and merged. |
| `skip`    | Decided not to do (note why). |

## How to work a task

1. Verify **all `deps` are `done`**. If not, the task is `blocked` — skip it.
2. Flip status `todo → wip`. One agent per task at a time.
3. Read the referenced `PLAN.md` sections before writing code.
4. Implement until **all acceptance items pass**. Not "mostly."
5. Run `make test` (once Makefile exists). Green = `done`. Red = debug.
6. Flip status `wip → done`. Commit task file edit together with code.

If you get stuck, flip status back to `todo`, add a `blockers:` note on
the task, and hand off.

---

## P — Prerequisites (repo scaffolding)

### P-001 — Initialize repo scaffolding
**Status:** `done` **Deps:** none
**Files:** `package.json`, `tsconfig.json`, `deno.json`, `Cargo.toml`, `Makefile`, `.gitignore`, `LICENSE`
**Acceptance:**
- `package.json` has `"type": "module"`, deps: `@excalidraw/excalidraw`, `linkedom`, `fontkit`, `esbuild`. Dev: `vitest`.
- `Cargo.toml` is a workspace listing `crates/excalidraw-image`.
- `deno.json` configures the dev-loop lint/format; imports from `src/core/**` only.
- `.gitignore` excludes `dist/`, `target/`, `node_modules/`, `.DS_Store`.
- `LICENSE` is MIT with "Rickard" as copyright holder.
- `make bootstrap` runs `npm ci && cargo fetch && deno cache src/core/dev.mjs` (file need not exist yet).

### P-002 — eslint config for `src/core/` host-neutrality
**Status:** `done` **Deps:** P-001
**Files:** `.eslintrc.cjs` or equivalent
**Acceptance:**
- `no-restricted-globals` forbids `Bun`, `Deno`, `process`, `Buffer`, `require`, `__dirname`, `__filename` in `src/core/**` except `src/core/dev.mjs`.
- `no-restricted-imports` forbids `fs`, `path`, `node:*`, `bun:*` in `src/core/**`.
- `npm run lint` fails on a planted violation; passes after reverting.

### P-003 — Skeleton directory tree
**Status:** `done` **Deps:** P-001
**Files:** see `PLAN.md` §7.
**Acceptance:**
- All directories from §7 exist with a `.gitkeep` where empty.
- `tests/fixtures/` contains at least `basic-shapes.excalidraw` (can be hand-crafted — one rectangle + one arrow).

### P-004 — Makefile targets
**Status:** `done` **Deps:** P-001, P-003
**Files:** `Makefile`
**Acceptance:**
- Targets: `bootstrap`, `core`, `fonts`, `dev`, `rust`, `parity`, `test`, `clean`.
- `make core` calls `node src/scripts/build-core.mjs` (script can be stub).
- `make dev` runs `deno run --allow-read src/core/dev.mjs tests/fixtures/basic-shapes.excalidraw`.
- `make test` runs `vitest run` + `cargo test` + `make parity`.
- `make` with no argument prints target help.

---

## F — Phase 0: Feasibility spike

### F-001 — Spike: bundle `@excalidraw/excalidraw` in Deno
**Status:** `todo` **Deps:** P-001, P-003
**Ref:** `PLAN.md` §3.1
**Files:** `spike/` (temporary; delete when done)
**Acceptance:**
- A throwaway `spike/entry.mjs` imports `exportToSvg` from the package root.
- Shims cover at minimum: linkedom DOM, canvas `measureText` stub, `FontFace` stub, `fetch` that 404s harmlessly.
- `esbuild entry.mjs --bundle --platform=neutral` produces a single `core.mjs`.
- `deno run --allow-read spike/dev.mjs fixtures/basic-shapes.excalidraw` prints an `<svg>` that opens in excalidraw.com.
- `meta.json` contains **no** `**/components/App.tsx`, `**/actions/**`, `**/hooks/**`, `**/locales/**`, `**/css/**` entries.
- If any forbidden path appears, document in task notes whether esbuild aliases + `.css` empty loader suffice (`PLAN.md` §5.7 step 2).

### F-002 — Spike: embed `core.mjs` in `deno_core`
**Status:** `blocked` **Deps:** F-001
**Ref:** `PLAN.md` §3.2
**Files:** `spike-rust/` (temporary)
**Acceptance:**
- Cargo project uses `deno_core` (latest stable) + `tokio` + `serde_v8` + `serde_json`.
- `main.rs` loads the spike `core.mjs` via `include_str!`, calls `globalThis.__render(...)`, awaits, pulls out `.svg`.
- Output byte-equals the Deno output on `basic-shapes.excalidraw`.
- Release binary stripped+LTO: note size in task notes. Target < 60 MB.
- Note cold-start time from `time cargo run --release -- fixture` in task notes.

### F-003 — Phase 0 decision one-pager
**Status:** `blocked` **Deps:** F-001, F-002
**Files:** `PHASE0.md` (delete at end of v1, or fold into README)
**Acceptance:** Documents decisions on package-root-vs-source, the deno_core version pin, Phase 0 size/perf numbers, and any shim surprises discovered. One page.

---

## J — Phase 1: JS core minimal happy path (no text)

### J-001 — `src/core/shims/dom.mjs`
**Status:** `blocked` **Deps:** P-002, F-001
**Ref:** `PLAN.md` §4.2, upstream `SVG_EXPORT.md` §3.1, §4
**Acceptance:**
- Installs linkedom `window`, `document`, `Node`, `Element`, `HTMLElement`, `SVGElement`, `DocumentFragment` on `globalThis`.
- Unit test: creates `<svg xmlns="…">`, appends a `<rect>` with `setAttributeNS`, asserts `outerHTML` round-trips the namespace.

### J-002 — `src/core/shims/base64.mjs`
**Status:** `blocked` **Deps:** J-001
**Acceptance:**
- `window.btoa`/`window.atob` work on Latin-1 strings without Node's `Buffer` global (use `Uint8Array` + `atob`/`btoa` polyfill or `TextEncoder`).
- Unit test: `btoa("hello") === "aGVsbG8="`; `atob(btoa("héllo"))` round-trips as binary bytes.

### J-003 — `src/core/shims/fonts.mjs`
**Status:** `blocked` **Deps:** J-001
**Ref:** `PLAN.md` §4.2, §4A.6
**Acceptance:**
- `globalThis.FontFace` stores `family`, `style`, `weight`, `display`, `unicodeRange` verbatim; `load()` returns `Promise.resolve(this)`.
- `document.fonts` has `add`, `delete`, `clear`, `has`, `check() → true`, `load() → []`, `ready: Promise<void>`.
- Unit test: constructing `new FontFace("Virgil", "url(...)", { unicodeRange: "U+0000-00FF" })` and adding to `document.fonts` reflects in `has`/`check`.

### J-004 — `src/core/shims/fetch-fonts.mjs`
**Status:** `blocked` **Deps:** J-001, FNT-002
**Ref:** `PLAN.md` §4.2, §4A.7
**Acceptance:**
- Installs `globalThis.fetch` that resolves URLs matching Excalidraw's font asset pattern from the base64 map in `font-assets.mjs`.
- Non-matching URLs throw `Error("network fetch not allowed in CLI: <url>")`.
- Response shape matches what Excalidraw calls: `.arrayBuffer()` works; `.ok` is `true`.
- Unit test: stub a font asset path; `await fetch(url).arrayBuffer()` returns the expected byte length.

### J-005 — `src/core/shims/canvas.mjs` (skeleton, no text metrics yet)
**Status:** `blocked` **Deps:** J-001
**Ref:** `PLAN.md` §4.2, upstream `SVG_EXPORT.md` §3.2
**Acceptance:**
- Wraps `document.createElement` so `"canvas"` returns an object with `getContext("2d")` that has `font` (settable string) and `measureText(text) → { width: text.length * 8 }` (placeholder — replaced in T-003).
- Non-`"canvas"` tags pass through to linkedom.
- Unit test: `document.createElement("canvas").getContext("2d").measureText("abc").width > 0`.

### J-006 — `src/core/shims/workers.mjs`
**Status:** `blocked` **Deps:** J-001
**Ref:** `PLAN.md` §4.2
**Acceptance:**
- Ensures `globalThis.Worker` is `undefined` at module load.
- Unit test: `typeof Worker === "undefined"` after importing.

### J-007 — `src/core/shims/install.mjs`
**Status:** `blocked` **Deps:** J-001..J-006
**Ref:** `PLAN.md` §4.2
**Acceptance:**
- Imports in order: `dom`, `base64`, `fonts`, `fetch-fonts`, `canvas`, `workers`.
- Side-effect-only; no exports.
- Unit test: importing once installs all shims; importing again is a no-op (idempotent).

### J-008 — `src/core/index.mjs` — `__render` entry
**Status:** `blocked` **Deps:** J-007
**Ref:** `PLAN.md` §4.1
**Acceptance:**
- Imports `shims/install.mjs` first, then `exportToSvg` from `@excalidraw/excalidraw`.
- Sets `globalThis.__render` to the adapter described in §4.1.
- Accepts `sceneJson` as string or object; normalizes to object.
- Does **not** import any `node:*`, `Bun.*`, `Deno.*`, `fs`, or `path`.
- Unit test: call `__render` on the `basic-shapes.excalidraw` fixture; result has `.svg` starting with `<svg`.

### J-009 — `src/core/dev.mjs` — Deno dev entry
**Status:** `blocked` **Deps:** J-008
**Ref:** `PLAN.md` §4.1.1
**Acceptance:**
- Works only under Deno (guards and exits otherwise).
- `deno run --allow-read src/core/dev.mjs tests/fixtures/basic-shapes.excalidraw` prints SVG to stdout.
- Exit 0 on success, 1 on error; error message goes to stderr.

### J-010 — `src/scripts/build-core.mjs` — esbuild build
**Status:** `blocked` **Deps:** J-008
**Ref:** `PLAN.md` §5.7
**Acceptance:**
- Bundles `src/core/index.mjs` → `dist/core.mjs` with `--format=esm --platform=neutral --bundle --minify --tree-shaking=true --legal-comments=none --metafile=dist/meta.json`.
- esbuild aliases: `react`, `react-dom`, `react-dom/client`, `jotai` → `src/core/stubs/empty.mjs`; `.css` loader `empty`.
- Defines: `process.env.NODE_ENV='"production"'`, `import.meta.env.DEV='false'`, `import.meta.env.PROD='true'`, `import.meta.env.PKG_NAME`, `import.meta.env.PKG_VERSION`.
- Produces `dist/core.mjs` + `dist/meta.json` without error.

### J-011 — `src/scripts/metafile-audit.mjs` — CI gate for forbidden imports
**Status:** `blocked` **Deps:** J-010
**Ref:** `PLAN.md` §5.7 step 4
**Acceptance:**
- Reads `dist/meta.json`, fails (exit 1) if any input path matches: `**/components/App.tsx`, `**/components/LayerUI.tsx`, `**/actions/**`, `**/hooks/**`, `**/i18n.ts`, `**/locales/**`, `**/css/**`.
- Prints offending paths, not the whole metafile.
- Hooked into `make test`.

### J-012 — Smoke test: basic shapes under Deno
**Status:** `blocked` **Deps:** J-009
**Files:** `tests/deno/render.test.mjs`, `tests/fixtures/basic-shapes.excalidraw`
**Acceptance:**
- Vitest-style (or Deno test) asserts output starts with `<svg`, contains a `<rect>` and a `<path>` (arrow), and is well-formed XML.
- Runs via `deno test --allow-read tests/deno/`.

---

## T — Phase 2: Text and metrics

### T-001 — `src/core/text-metrics.mjs` — `FontkitTextMetricsProvider`
**Status:** `blocked` **Deps:** J-008, FNT-002
**Ref:** `PLAN.md` §4A.2
**Acceptance:**
- Class exposes `getLineWidth(text, fontString)`.
- Lazily loads a fontkit `Font` from a base64 WOFF2 via `fontkit.create(buf)`; caches per family.
- Parses `"<N>px <family>, …"` — captures `N` and the first family name only.
- Unit test: `getLineWidth("Hello", "20px Excalifont") > 0` and within ±20% of the string-length heuristic.

### T-002 — Font-string parser
**Status:** `blocked` **Deps:** none
**Files:** inside `src/core/text-metrics.mjs`
**Acceptance:**
- `parseFontString("20px Virgil, Segoe UI Emoji")` → `{ pxSize: 20, family: "Virgil" }`.
- Handles: integer px, fractional px, quoted family names (`'Comic Shanns'`), extra whitespace.
- Unit tests cover at least 6 real scenes' font strings.

### T-003 — Wire canvas shim to fontkit provider
**Status:** `blocked` **Deps:** J-005, T-001
**Ref:** `PLAN.md` §4.2, upstream `SVG_EXPORT.md` §3.2
**Acceptance:**
- `document.createElement("canvas").getContext("2d").measureText(text).width` returns the fontkit-measured width for the current `font` string.
- Changing `font` between calls changes the measured width.
- Same `FontkitTextMetricsProvider` instance is shared with T-004.

### T-004 — Register provider via `setCustomTextMetricsProvider`
**Status:** `blocked` **Deps:** T-001, J-008
**Ref:** upstream `SVG_EXPORT.md` §3.2
**Acceptance:**
- `src/core/index.mjs` imports and calls `setCustomTextMetricsProvider(provider)` from `@excalidraw/element/textMeasurements` once.
- Without this call, text-wrapped fixture wraps at wrong width (sanity regression test).

### T-005 — Fixture: wrapped text + long text
**Status:** `blocked` **Deps:** P-003
**Files:** `tests/fixtures/text-wrapped.excalidraw`
**Acceptance:**
- Scene has one text element in Virgil and one in Excalifont; both wrapped inside containers of known widths (300px and 500px).
- File round-trips on excalidraw.com.

### T-006 — Line-wrap parity gate (§4A.2)
**Status:** `blocked` **Deps:** T-003, T-004, T-005
**Ref:** `PLAN.md` §4A.2, §4A.8 gate 5
**Acceptance:**
- Headless-browser oracle (Playwright + excalidraw.com) renders the fixture; records line break columns per paragraph.
- Our CLI renders the same fixture; line break columns must be within ±1 per line.
- Failure prints both sides for the failing line. Gate blocks Phase 2 completion.

---

## FNT — Phase 3: Fonts (critical path; see PLAN §4A)

### FNT-001 — `src/scripts/build-font-assets.mjs`
**Status:** `blocked` **Deps:** P-001
**Ref:** `PLAN.md` §4A.3, §4A.7
**Acceptance:**
- Reads `node_modules/@excalidraw/excalidraw/dist/prod/fonts/` recursively for `*.woff2`.
- Emits `src/core/font-assets.mjs` with a frozen map `family → [{ path, base64, unicodeRange? }]`.
- `unicodeRange` read from Excalidraw's `fonts.css` or per-family descriptors; verbatim.
- Deterministic output (stable ordering) so the file diffs cleanly on dep bumps.
- Running `make fonts` twice on unchanged input produces no diff.

### FNT-002 — `src/core/font-assets.mjs` committed initial version
**Status:** `blocked` **Deps:** FNT-001
**Acceptance:**
- Generated once, committed. Counts match `node_modules/.../fonts/` byte-for-byte (234 WOFF2s as of Excalidraw 0.18.0).

### FNT-003 — Inventory integrity test (§4A.8 gate 1)
**Status:** `blocked` **Deps:** FNT-002
**Files:** `tests/js/font-inventory.test.mjs`
**Acceptance:**
- Walks the installed npm font dir, hashes each file, compares to `font-assets.mjs`.
- Fails on extra/missing/modified file; prints diff.
- Included in `make test`.

### FNT-004 — Subset round-trip test per family (§4A.8 gate 2)
**Status:** `blocked` **Deps:** FNT-002
**Files:** `tests/js/font-subset.test.mjs`
**Ref:** `PLAN.md` §4A.3
**Acceptance:**
- For each supported family (Excalifont, Virgil, Nunito, Lilita One, Comic Shanns, Cascadia, Liberation, Xiaolai): subset to `{'A','B','C'}` through Excalidraw's subset pipeline; assert the resulting WOFF2 parses, has non-empty `hmtx` and `cmap`, and contains glyphs for all 3 codepoints.
- Xiaolai uses CJK codepoints instead of ABC.

### FNT-005 — Browser fidelity test (§4A.8 gate 3)
**Status:** `blocked` **Deps:** T-006, FNT-004
**Files:** `tests/js/browser-fidelity.test.mjs`
**Ref:** `PLAN.md` §4A.8 gate 3
**Acceptance:**
- Playwright headless-Chrome renders CLI output for a 100-char string in each family.
- Extracts computed text width via `getComputedTextLength()`.
- Baseline widths captured once from a reference excalidraw.com render; committed to `tests/js/fixtures/font-fidelity-baseline.json`.
- Tolerance: ≤2 px per 100-char string.

### FNT-006 — Mixed-script fixture (§4A.8 gate 4)
**Status:** `blocked` **Deps:** P-003
**Files:** `tests/fixtures/mixed-script.excalidraw`
**Acceptance:**
- Scene text contains Latin + CJK (via Xiaolai fallback) + emoji (best-effort) in a single text element.
- CLI output shows: Latin glyphs resolve to Excalifont, CJK glyphs to Xiaolai via unicode-range matching.

### FNT-007 — Wrap-parity fixture (§4A.8 gate 5)
**Status:** `blocked` **Deps:** T-006
**Files:** `tests/fixtures/wrap-400.excalidraw`
**Acceptance:**
- 400-char paragraph at 300 px container width.
- Reference line breaks captured once via excalidraw.com export.
- CLI output must match within ±1 break column per line.

### FNT-008 — Helvetica → Liberation aliasing
**Status:** `blocked` **Deps:** J-008
**Ref:** `PLAN.md` §4A.5
**Acceptance:**
- Scene with `font-family: Helvetica` renders text with Liberation Sans metrics.
- Emitted SVG `font-family` string still lists `Helvetica` first (so embedded-scene round-trips).

### FNT-009 — Unknown family fallback + `--strict-fonts`
**Status:** `blocked` **Deps:** J-008
**Ref:** `PLAN.md` §4A.5
**Acceptance:**
- By default, unknown numeric family IDs render with Excalifont metrics.
- `opts.strictFonts: true` in the `__render` call rejects with an error listing offending families.
- Rust `--strict-fonts` flag maps to this option (see R-002).

### FNT-010 — Emoji local-only handling
**Status:** `blocked` **Deps:** J-008
**Ref:** `PLAN.md` §4A.6
**Acceptance:**
- No `@font-face` is emitted for Segoe UI Emoji.
- The SVG `font-family` string still keeps `Segoe UI Emoji` in the fallback list.
- Documented in README as a known limitation.

### FNT-011 — `.excalidraw.svg` font metadata round-trip (§4A.8 gate 6)
**Status:** `blocked` **Deps:** E-001
**Files:** `tests/js/font-roundtrip.test.mjs`
**Acceptance:**
- Export a scene with `--embed-scene`; decode the base64 payload back.
- Assert every text element's `fontFamily` (numeric) and the family fallback string in SVG `font-family` match the input exactly.

---

## I — Phase 4: Images and frames

### I-001 — Image fixture (dataURL)
**Status:** `blocked` **Deps:** P-003
**Files:** `tests/fixtures/image.excalidraw`
**Acceptance:** Contains a PNG image element with `dataURL` in `files`. Opens cleanly on excalidraw.com.

### I-002 — Cropped image fixture (mask path)
**Status:** `blocked` **Deps:** P-003
**Files:** `tests/fixtures/image-cropped.excalidraw`
**Acceptance:** Image with non-trivial crop that exercises the `<mask>` code path in `renderer/staticSvgScene.ts`.

### I-003 — Frames fixture
**Status:** `blocked` **Deps:** P-003
**Files:** `tests/fixtures/frames.excalidraw`
**Acceptance:** Two frames, one with a name that requires truncation (exercises `scene/export.ts:69`), children clipped to frame bounds.

### I-004 — Images + frames smoke tests
**Status:** `blocked` **Deps:** J-012, I-001, I-002, I-003
**Acceptance:**
- CLI output for each fixture is valid SVG.
- Output contains `<image href="data:image/...">` with non-empty `href`.
- Cropped fixture output contains a `<mask>` or `<clipPath>` referenced by the image.
- Frames fixture clips children: a `<clipPath>` with the frame's bounds exists and is referenced.

---

## E — Phase 5: Editable `.excalidraw.svg`

### E-001 — `--embed-scene` wiring
**Status:** `blocked` **Deps:** J-008
**Ref:** `PLAN.md` §4.4, upstream `SVG_EXPORT.md` §3.5
**Acceptance:**
- `__render(scene, { embedScene: true })` sets `appState.exportEmbedScene = true`.
- Output SVG contains `<!-- svg-source:excalidraw -->`, `<metadata>`, `<!-- payload-start -->…`, `<!-- payload-end -->` in the documented order.

### E-002 — linkedom metadata serialization test
**Status:** `blocked` **Deps:** E-001
**Files:** `tests/js/metadata-serialization.test.mjs`
**Ref:** `PLAN.md` §11 risk 6
**Acceptance:**
- Regex `/<!-- payload-start -->\s*(.+?)\s*<!-- payload-end -->/s` matches the output and captures non-empty base64.
- If linkedom collapses/reorders children, task is reopened with a mitigation plan (manual string injection).

### E-003 — Round-trip test
**Status:** `blocked` **Deps:** E-001
**Files:** `tests/js/roundtrip.test.mjs`
**Acceptance:**
- For each fixture: `__render(scene, { embedScene: true }).svg` → extract base64 → `decodeSvgBase64Payload` from `@excalidraw/excalidraw/data/encode` → deep-equal original `elements` and `files` (ignoring `source` field).
- Passes for basic, text-wrapped, mixed-script, image, frames fixtures.

---

## R — Phase 6: Rust shell

### R-001 — `crates/excalidraw-image/Cargo.toml`
**Status:** `blocked` **Deps:** P-001, F-002
**Ref:** `PLAN.md` §5.1, §5.6
**Acceptance:**
- Dependencies: `deno_core` (pinned version from F-003), `tokio` (`rt`, `macros`), `serde`, `serde_json`, `serde_v8`, `anyhow`, `clap` (or `lexopt` — pick in §5.2).
- `[profile.release]`: `lto = "fat"`, `codegen-units = 1`, `strip = "symbols"`, `panic = "abort"`, `opt-level = "z"`.
- Crate metadata: `name = "excalidraw-image"`, description, license MIT, repository, keywords.

### R-002 — `src/argv.rs` — argv parser
**Status:** `blocked` **Deps:** R-001
**Ref:** `PLAN.md` §5.4
**Acceptance:**
- Flags implemented: `-o/--output`, `--format`, `--embed-scene`, `--no-background`, `--dark`, `--padding`, `--scale`, `--frame`, `--max`, `--skip-font-inline`, `--strict-fonts`, `-h/--help`, `-v/--version`.
- `Args::opts_json()` serializes to the JSON shape `__render` expects (see J-008).
- Unit tests cover: stdin input (`-`), stdout output (`-`), `--format` inference from extension, conflicting flags error out.

### R-003 — `src/engine.rs` — `deno_core` wrapper
**Status:** `blocked` **Deps:** R-001
**Ref:** `PLAN.md` §5.2
**Acceptance:**
- `Engine::new()` creates a `JsRuntime` with `NoopModuleLoader` and loads `include_str!(concat!(env!("OUT_DIR"), "/core.mjs"))`.
- `Engine::render(scene, opts)` evaluates the trampoline, awaits the promise, deserializes `{ svg: String }` via `serde_v8`.
- Integration test loads the bundled `core.mjs`, renders `basic-shapes.excalidraw`, asserts output starts with `<svg`.

### R-004 — `src/main.rs`
**Status:** `blocked` **Deps:** R-002, R-003
**Ref:** `PLAN.md` §5.3
**Acceptance:**
- Reads input from file or stdin; writes output to file or stdout.
- Uses `#[tokio::main(flavor = "current_thread")]`.
- Exits 0 on success, 1 on parse/render error (with message to stderr), 2 on argv errors.

### R-005 — `build.rs` — copy `dist/core.mjs` + fonts into `OUT_DIR`
**Status:** `blocked` **Deps:** J-010, FNT-002, R-001
**Ref:** `PLAN.md` §5.9
**Acceptance:**
- `build.rs` copies `../../dist/core.mjs` to `OUT_DIR/core.mjs`.
- Generates `OUT_DIR/embedded_fonts.rs` with a `static EMBEDDED_FONTS: &[(&str, &[u8])]` table built from `src/core/font-assets.mjs`.
- Re-runs on change of `core.mjs` or `font-assets.mjs` (via `cargo:rerun-if-changed`).
- Also mirrors to `crates/excalidraw-image/assets/` for `cargo publish` self-containment.

### R-006 — Single-fixture smoke test
**Status:** `blocked` **Deps:** R-004, R-005
**Files:** `tests/rust/smoke.rs`
**Acceptance:** `cargo test -p excalidraw-image smoke` runs the binary against `basic-shapes.excalidraw`, asserts SVG output.

### R-007 — Parity gate: Deno vs Rust byte-identical output (§8.2)
**Status:** `blocked` **Deps:** R-006, J-012
**Files:** `tests/rust/parity.rs`
**Ref:** `PLAN.md` §8.2
**Acceptance:**
- For every fixture in `tests/fixtures/`: spawn `deno run src/core/dev.mjs <fixture>`, run `cargo run -- <fixture>`, assert **byte-equal** stdout.
- If a host-specific difference is unavoidable (e.g., RNG seeding), the Deno and Rust hosts share a seed via env var or the JS core takes a deterministic seed from opts.
- Gate runs in CI on every PR.

### R-008 — Error handling and exit codes
**Status:** `blocked` **Deps:** R-004
**Acceptance:**
- Invalid JSON input: exit 1, stderr starts with `error: failed to parse`.
- Missing file: exit 1, stderr mentions the path.
- Unknown flag: exit 2, stderr prints `--help`.
- JS-thrown error: exit 1, stderr includes the JS error message (not just `Error: undefined`).

---

## PNG — Phase 7: PNG via native `resvg`

### PNG-001 — `src/raster.rs` — `resvg` integration
**Status:** `blocked` **Deps:** R-004, R-005
**Ref:** `PLAN.md` §5.5
**Acceptance:**
- `raster::svg_to_png(svg, args) -> Result<Vec<u8>>`.
- Builds `fontdb::Database` from `EMBEDDED_FONTS` (R-005).
- Honors `args.scale` and `args.max`.
- Returns deterministic PNG bytes (same input → same output).

### PNG-002 — `--format png` end-to-end
**Status:** `blocked` **Deps:** PNG-001, R-002
**Acceptance:**
- `excalidraw-image fixture.excalidraw -o out.png` writes a valid PNG.
- `file out.png` reports `PNG image data`.
- `identify out.png` width/height match the fixture's bounding box at `args.scale`.

### PNG-003 — PNG fixtures and snapshot
**Status:** `blocked` **Deps:** PNG-002
**Files:** `tests/fixtures/*.png.snapshot` (binary golden)
**Acceptance:**
- Golden PNGs generated once; test diffs via pixel-match (tolerance ≤1 per 100k pixels).
- Covers: basic shapes, text, image, frames.

### PNG-004 — PNG font fidelity
**Status:** `blocked` **Deps:** PNG-001, FNT-005
**Acceptance:** `resvg` picks the correct bundled WOFF2 for each text element via `fontdb` matching. Compare rendered text region against a headless-browser PNG of the same scene: SSIM ≥ 0.95.

---

## SZ — Phase 8: Size + cross-compile

### SZ-001 — Cross-compile matrix via `cross` or per-OS runners
**Status:** `blocked` **Deps:** R-007
**Ref:** `PLAN.md` §8.2
**Acceptance:**
- Local `make rust-cross` builds all 5 targets: `x86_64-apple-darwin`, `aarch64-apple-darwin`, `x86_64-unknown-linux-gnu`, `aarch64-unknown-linux-gnu`, `x86_64-pc-windows-msvc`.
- Each produces a binary that runs `basic-shapes.excalidraw` successfully (via QEMU for linux-arm64 in CI if needed).

### SZ-002 — Binary size regression test
**Status:** `blocked` **Deps:** SZ-001
**Acceptance:**
- `tests/size-budget.json` records per-platform target sizes.
- CI compares release binary size to budget; fails if >5% over.
- Initial budget: 50 MB per platform.

### SZ-003 — Tree-shake audit hooked into CI
**Status:** `blocked` **Deps:** J-011
**Acceptance:** `npm run audit:metafile` runs on every PR; green = no forbidden imports.

---

## REL — Phase 9: Release pipeline

### REL-001 — `.github/workflows/test.yml`
**Status:** `blocked` **Deps:** R-007, PNG-003, FNT-003, FNT-005
**Acceptance:**
- On PR: matrix (ubuntu-latest, macos-14, windows-latest) runs `make test`.
- Sets up Node, Deno, Rust; caches node_modules, cargo registry, target dir.
- Green on main required for merge.

### REL-002 — `.github/workflows/release.yml`
**Status:** `blocked` **Deps:** SZ-001
**Acceptance:**
- Triggered on tag `v*`.
- Cross-builds all 5 targets.
- Creates tarballs `excalidraw-image-<triple>.tar.gz` containing `excalidraw-image[.exe]` + LICENSE + README.
- Uploads to GitHub Release.
- Opens PR on `rickardp/homebrew-tap` bumping formula (via GH CLI).
- `cargo publish --dry-run` runs; real publish gated on manual workflow approval.

### REL-003 — macOS codesigning
**Status:** `blocked` **Deps:** REL-002
**Acceptance:**
- If `APPLE_DEVELOPER_ID_CERT` secret present: codesign + notarize both macOS binaries before tarball.
- If absent: skip with warning; README documents the Gatekeeper bypass (`xattr -d com.apple.quarantine`).

### REL-004 — Homebrew tap repo
**Status:** `blocked` **Deps:** REL-002
**Files:** `rickardp/homebrew-tap` (external repo)
**Acceptance:**
- Repo exists with `Formula/excalidraw-image.rb` matching §5.8.
- `brew tap rickardp/tap && brew install excalidraw-image` on macOS works end-to-end on a fresh machine.

### REL-005 — `cargo install` verification
**Status:** `blocked` **Deps:** REL-002
**Acceptance:**
- From a fresh clone: `cargo install --path crates/excalidraw-image` builds and produces a working binary.
- After first crates.io publish: `cargo install excalidraw-image` works without the repo present.

### REL-006 — `cargo-binstall` metadata
**Status:** `blocked` **Deps:** REL-002
**Acceptance:**
- `[package.metadata.binstall]` in `Cargo.toml` points to the GH Release tarball URL pattern.
- `cargo binstall excalidraw-image` on a fresh machine pulls the binary.

---

## D — Phase 10: Docs and polish

### D-001 — README
**Status:** `blocked` **Deps:** R-007, PNG-002
**Files:** `README.md`
**Acceptance:**
- Install section: `brew install`, `cargo install`, GH Release download.
- Quickstart: 3 invocations (SVG, embedded SVG, PNG).
- CLI reference (generated from `--help` or kept in sync manually).
- Fidelity caveats: line-wrap ±1 char, emoji not guaranteed, sub-pixel divergence from web app.
- Link to `PLAN.md` for architecture, `SVG_EXPORT.md` for the deep dive.

### D-002 — `--help` polish
**Status:** `blocked` **Deps:** R-002
**Acceptance:** Output fits in 80 cols; grouped (Inputs / Outputs / Rendering / Fonts); includes an examples section.

### D-003 — Fidelity caveats doc
**Status:** `blocked` **Deps:** FNT-005, PNG-004
**Files:** `docs/fidelity.md`
**Acceptance:** Documents expected divergences from web-app output and why. Links to relevant PLAN sections.

### D-004 — Fixture snapshot baseline
**Status:** `blocked` **Deps:** R-007
**Acceptance:** All `tests/fixtures/*.excalidraw` have committed golden `.svg` (and `.png` for Phase 7 fixtures). `vitest -u` and `cargo insta review` workflows documented in README.

---

## Appendix: agent guardrails

- **Do not** commit `dist/`, `target/`, or `node_modules/`.
- **Do not** skip the parity gate (R-007) by special-casing either host. If
  Deno and Rust disagree, fix the JS, not the test.
- **Do not** add new top-level dependencies without updating `PLAN.md`.
- **Do not** write files under `/Users/rickard/oss/excalidraw/` — that's
  the upstream read-only reference checkout.
- When a task's acceptance criteria cannot be met, write the reason under
  a `blockers:` note on the task and flip back to `todo`.
