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
**Status:** `done` **Deps:** P-001, P-003
**Ref:** `PLAN.md` §3.1
**Files:** `spike/` (kept in repo; F-002 depends on the generated `spike/core.mjs`)
**Acceptance:**
- A throwaway `spike/entry.mjs` imports `exportToSvg` from the package root.
- Shims cover at minimum: linkedom DOM, canvas `measureText` stub, `FontFace` stub, `fetch` that 404s harmlessly.
- `esbuild entry.mjs --bundle --platform=neutral` produces a single `core.mjs`.
- `deno run --allow-read spike/dev.mjs fixtures/basic-shapes.excalidraw` prints an `<svg>` that opens in excalidraw.com.
- `meta.json` contains **no** `**/components/App.tsx`, `**/actions/**`, `**/hooks/**`, `**/locales/**`, `**/css/**` entries.
- If any forbidden path appears, document in task notes whether esbuild aliases + `.css` empty loader suffice (`PLAN.md` §5.7 step 2).

**Notes (completion):**
- Hypothesis holds. See `spike/README.md` for the full report.
- Bundle size: 4.13 MB unminified, 3.18 MB minified.
- Zero real forbidden paths in `meta.json`. Locales show as `stub-virtual:./locales/*` (plugin-replaced, not real source); J-011 audit script must skip `stub-virtual:` inputs.
- `PLAN.md` §5.7 step 2 aliases (`react`, `react-dom`, `jotai`, `.css:empty`) are **necessary but not sufficient**. Real J-010 needs additionally: `@excalidraw/mermaid-to-excalidraw`, the entire `@radix-ui/*` family, `jotai-scope`, `react/jsx-runtime`, `react/jsx-dev-runtime`, and the `locales/*.js` dynamic-import pattern. Stub module must be a callable `Proxy` (plain `{}` breaks `const { x } = createIsolation()` destructuring). `platform=neutral` requires explicit `mainFields: ["browser","module","main"]` + `conditions: ["module","import","browser","default"]`. See `spike/build.mjs`.
- One shim surprise: `devicePixelRatio` is read at module-eval time by the renderer chunk; must be set on `globalThis` (and `window`) before `exportToSvg` import. Add to J-001.

### F-002 — Spike: embed `core.mjs` in `deno_core`
**Status:** `done` **Deps:** F-001
**Ref:** `PLAN.md` §3.2
**Files:** `spike-rust/` (temporary)
**Acceptance:**
- Cargo project uses `deno_core` (latest stable) + `tokio` + `serde_v8` + `serde_json`.
- `main.rs` loads the spike `core.mjs` via `include_str!`, calls `globalThis.__render(...)`, awaits, pulls out `.svg`.
- Output byte-equals the Deno output on `basic-shapes.excalidraw`.
- Release binary stripped+LTO: note size in task notes. Target < 60 MB.
- Note cold-start time from `time cargo run --release -- fixture` in task notes.

**Notes (completion):**
- Hypothesis holds. See `spike-rust/README.md` for the full report.
- **deno_core version pinned: `0.399.0`** (latest stable on crates.io as of 2026-04-24). PLAN §3.2's `"0.318"` is stale — API has moved: `handle_scope` is now the `deno_core::scope!` macro, `resolve_value` is deprecated in favor of `resolve` + `with_event_loop_promise`. `serde_v8` is re-exported from `deno_core`.
- Release binary: **43.6 MB** (45,744,528 B). Budget 60 MB. Pass.
- Cold start: **80 ms** median of 5 runs on `basic-shapes.excalidraw` (Apple Silicon). Budget 400 ms. Pass.
- Parity: **byte-identical** to Deno output (SHA-256 `21d5511f...3e26866`).
- **Key finding — bundle is not actually host-neutral.** `deno_core`'s default runtime provides almost nothing beyond `console`, `queueMicrotask`, `globalThis`. Deno ships `atob`, `btoa`, `DOMException`, `URL`, `URLSearchParams`, `TextEncoder`/`TextDecoder`, `Event`, `EventTarget`, `performance`, `setTimeout`, `fetch`, `crypto`, `AbortController`, etc. The F-001 bundle tacitly depends on several of these. Spike adds them in `spike-rust/src/polyfills.js`; R-001 should move equivalents into `src/core/shims/install.mjs` (preferred) or adopt the `deno_webidl`/`deno_url`/`deno_web`/`deno_console` extensions from the Deno stack.
- **Key finding — `load_main_es_module_from_code` swallowed synchronous throws.** The ES-module evaluation path in 0.399 returned Ok from `mod_evaluate` even when the module threw during top-level eval. Switched to classic-script `execute_script` and rewrote the 5 `import.meta.url`/`import.meta.env` references in the bundle to literals. J-010 should add these as esbuild `define` entries so the bundle is evaluable without post-processing.
- J-001 shim ordering needs to include WHATWG polyfills before DOM shims. Update P-002 ESLint rule to also forbid direct reads of `atob`/`btoa`/`DOMException`/`URL`/etc. outside `src/core/shims/**`.

### F-003 — Phase 0 decision one-pager
**Status:** `todo` **Deps:** F-001, F-002
**Files:** `PHASE0.md` (delete at end of v1, or fold into README)
**Acceptance:** Documents decisions on package-root-vs-source, the deno_core version pin, Phase 0 size/perf numbers, and any shim surprises discovered. One page.

---

## J — Phase 1: JS core minimal happy path (no text)

### J-001 — `src/core/shims/dom.mjs`
**Status:** `done` **Deps:** P-002, F-001 (both `done`)
**Ref:** `PLAN.md` §4.2, upstream `SVG_EXPORT.md` §3.1, §4, `PHASE0.md` §"Finding C"
**Acceptance:**
- Installs linkedom `window`, `document`, `Node`, `Element`, `HTMLElement`, `SVGElement`, `DocumentFragment` on `globalThis`.
- Also sets `globalThis.devicePixelRatio = 1` **before** the return — F-001 finding: Excalidraw's renderer chunk reads `devicePixelRatio` at module-eval time. (Kept inside the DOM shim rather than a separate file because it's a one-liner and logically "environmental window globals.")
- Unit test: creates `<svg xmlns="…">`, appends a `<rect>` with `setAttributeNS`, asserts `outerHTML` round-trips the namespace.
- Unit test: after importing, `typeof globalThis.devicePixelRatio === "number"` and equals 1.

### J-002 — `src/core/shims/web-globals.mjs` (EXPANDED per F-002)
**Status:** `done` **Deps:** J-001
**Ref:** `PHASE0.md` §"Finding B", `PLAN.md` §4.2
**Acceptance:**
- File renamed from `base64.mjs` to `web-globals.mjs` — F-002 discovered `deno_core` lacks many Web-platform globals that Deno silently provides. This shim now covers the full set.
- Installs on both `window` and `globalThis`:
  - `btoa`, `atob` — `btoa("hello") === "aGVsbG8="`; `atob(btoa("héllo"))` round-trips.
  - `URL`, `URLSearchParams` — `new URL("https://a/b?c=1").searchParams.get("c") === "1"`.
  - `TextEncoder`, `TextDecoder` — round-trip non-ASCII.
  - `Event`, `EventTarget` — minimal spec, `addEventListener` + `dispatchEvent` functional.
  - `DOMException` — constructor accepts `(message, name)`.
  - `performance.now()` — monotonic numeric.
  - `setTimeout`, `clearTimeout`, `setInterval`, `clearInterval` — use host-provided if present (deno_core's timer ops work); polyfill only the missing ones.
- **Single JS source of truth**: polyfill in JS, NOT via `deno_core` extensions. The parity gate (R-007) requires Deno and `deno_core` to run identical code.
- Reuse third-party polyfill code (`event-target-shim`, small TextEncoder polyfills) where it bundles cleanly with esbuild `--platform=neutral`. Budget: ≤5 KB added to minified bundle.
- Unit test covers each of the above.

**Agent notes:** Start from `spike-rust/src/polyfills.js` (the minimum set F-002 proved necessary). Expand to the full list. Also update `PLAN.md` §7 repo-layout to rename the shim file.

### J-003 — `src/core/shims/fonts.mjs`
**Status:** `done` **Deps:** J-001
**Ref:** `PLAN.md` §4.2, §4A.6
**Acceptance:**
- `globalThis.FontFace` stores `family`, `style`, `weight`, `display`, `unicodeRange` verbatim; `load()` returns `Promise.resolve(this)`.
- `document.fonts` has `add`, `delete`, `clear`, `has`, `check() → true`, `load() → []`, `ready: Promise<void>`.
- Unit test: constructing `new FontFace("Virgil", "url(...)", { unicodeRange: "U+0000-00FF" })` and adding to `document.fonts` reflects in `has`/`check`.

### J-004 — `src/core/shims/fetch-fonts.mjs`
**Status:** `done` **Deps:** J-001, FNT-002
**Ref:** `PLAN.md` §4.2, §4A.7
**Acceptance:**
- Installs `globalThis.fetch` that resolves URLs matching Excalidraw's font asset pattern from the base64 map in `font-assets.mjs`.
- Non-matching URLs throw `Error("network fetch not allowed in CLI: <url>")`.
- Response shape matches what Excalidraw calls: `.arrayBuffer()` works; `.ok` is `true`.
- Unit test: stub a font asset path; `await fetch(url).arrayBuffer()` returns the expected byte length.

### J-005 — `src/core/shims/canvas.mjs` (skeleton, no text metrics yet)
**Status:** `done` **Deps:** J-001
**Ref:** `PLAN.md` §4.2, upstream `SVG_EXPORT.md` §3.2
**Acceptance:**
- Wraps `document.createElement` so `"canvas"` returns an object with `getContext("2d")` that has `font` (settable string) and `measureText(text) → { width: text.length * 8 }` (placeholder — replaced in T-003).
- Non-`"canvas"` tags pass through to linkedom.
- Unit test: `document.createElement("canvas").getContext("2d").measureText("abc").width > 0`.

### J-006 — `src/core/shims/workers.mjs`
**Status:** `done` **Deps:** J-001
**Ref:** `PLAN.md` §4.2
**Acceptance:**
- Ensures `globalThis.Worker` is `undefined` at module load.
- Unit test: `typeof Worker === "undefined"` after importing.

### J-007 — `src/core/shims/install.mjs`
**Status:** `done` **Deps:** J-001..J-006
**Ref:** `PLAN.md` §4.2 (updated install order), `PHASE0.md` Findings B+C
**Acceptance:**
- Imports in order: `dom` (sets devicePixelRatio + linkedom window/document), `web-globals` (URL, TextEncoder, Event, etc. — renamed from base64), `fonts` (FontFace + document.fonts), `fetch-fonts` (requires FNT-002 done), `canvas` (createElement wrapper), `workers` (Worker=undefined).
- Side-effect-only; no exports.
- Unit test: importing once installs all shims; importing again is a no-op (idempotent).
- Unit test: after install, each shim's signature globals are present (`document`, `URL`, `FontFace`, `fetch`, `HTMLCanvasElement`, `typeof Worker === "undefined"`).

### J-008 — `src/core/index.mjs` — `__render` entry
**Status:** `done` **Deps:** J-007
**Ref:** `PLAN.md` §4.1
**Acceptance:**
- Imports `shims/install.mjs` first, then `exportToSvg` from `@excalidraw/excalidraw`.
- Sets `globalThis.__render` to the adapter described in §4.1.
- Accepts `sceneJson` as string or object; normalizes to object.
- Does **not** import any `node:*`, `Bun.*`, `Deno.*`, `fs`, or `path`.
- Unit test: call `__render` on the `basic-shapes.excalidraw` fixture; result has `.svg` starting with `<svg`.

### J-009 — `src/core/dev.mjs` — Deno dev entry
**Status:** `done` **Deps:** J-008
**Ref:** `PLAN.md` §4.1.1
**Acceptance:**
- Works only under Deno (guards and exits otherwise).
- `deno run --allow-read src/core/dev.mjs tests/fixtures/basic-shapes.excalidraw` prints SVG to stdout.
- Exit 0 on success, 1 on error; error message goes to stderr.

### J-010 — `src/scripts/build-core.mjs` — esbuild build
**Status:** `done` **Deps:** J-008
**Ref:** `PLAN.md` §5.7
**Acceptance:**
- Bundles `src/core/index.mjs` → `dist/core.mjs` with `--format=esm --platform=neutral --bundle --minify --tree-shaking=true --legal-comments=none --metafile=dist/meta.json`.
- esbuild aliases: `react`, `react-dom`, `react-dom/client`, `jotai` → `src/core/stubs/empty.mjs`; `.css` loader `empty`.
- Defines: `process.env.NODE_ENV='"production"'`, `import.meta.env.DEV='false'`, `import.meta.env.PROD='true'`, `import.meta.env.PKG_NAME`, `import.meta.env.PKG_VERSION`.
- Produces `dist/core.mjs` + `dist/meta.json` without error.

**Notes (completion):**
- Expanded alias list per PHASE0.md Finding A: adds `react/jsx-runtime`,
  `react/jsx-dev-runtime`, `jotai-scope`, `@excalidraw/mermaid-to-excalidraw`,
  plus a plugin for the `@radix-ui/*` wildcard and a plugin that routes
  Excalidraw's dynamic `./locales/*.js` imports to the stub. Target stub is
  the new `src/core/stubs/proxy.mjs` (callable-Proxy pattern), not the
  original `empty.mjs` — a plain `{}` breaks `Object.assign` and
  destructuring downstream. Added `drop: ["console", "debugger"]` per
  PLAN §5.7 step 3 and `import.meta.url` define per PHASE0.md Finding D.
- Bundle is 20,722,902 B (19.8 MB). Over the task's 10 MB target because
  `src/core/shims/fetch-fonts.mjs` imports `src/core/font-assets.mjs`
  (17.5 MB of base64 WOFF2). That matches PHASE0.md §4's v1 projection
  ("Embedded fonts (base64 in JS) +12–17 MB raw"); the 10 MB figure in
  J-010 predates that line item. Total binary still projects to ~50 MB.
- Zero real forbidden-path inputs in `dist/meta.json`.
- Smoke test (`import dist/core.mjs; __render(basic-shapes.excalidraw)`)
  fails under Deno with `TypeError: Cannot read properties of undefined
  (reading 'origin')` because the bundle reads `window.location.origin` at
  module-eval time and `src/core/shims/dom.mjs` does not set
  `window.location` (the F-001 `spike/shims.mjs` did — `globalThis.location`
  line 31). Pre-setting `globalThis.location = { href: "http://localhost/",
  origin: "http://localhost" }` before importing the bundle produces the
  expected `<svg height="140" width="420.08096678629516" viewB…`. Shim gap;
  task scope forbids editing shims, flagging for a follow-up on J-001.

### J-011 — `src/scripts/metafile-audit.mjs` — CI gate for forbidden imports
**Status:** `done` **Deps:** J-010
**Ref:** `PLAN.md` §5.7 step 4
**Acceptance:**
- Reads `dist/meta.json`, fails (exit 1) if any input path matches: `**/components/App.tsx`, `**/components/LayerUI.tsx`, `**/actions/**`, `**/hooks/**`, `**/i18n.ts`, `**/locales/**`, `**/css/**`.
- Prints offending paths, not the whole metafile.
- Hooked into `make test`.

### J-012 — Smoke test: basic shapes under Deno
**Status:** `done` **Deps:** J-009, J-010
**Files:** `tests/deno/render.test.mjs`, `tests/js/bundle-smoke.test.mjs`, `tests/fixtures/basic-shapes.excalidraw`, `Makefile`
**Acceptance:**
- Vitest-style (or Deno test) asserts output starts with `<svg`, contains a `<rect>` and a `<path>` (arrow), and is well-formed XML.
- Runs via `deno test --allow-read tests/deno/`.

**Notes (completion):**
- Deno test imports `dist/core.mjs` directly (not `src/core/index.mjs`), so
  it validates the esbuild alias + stub chain that J-010 produces. Raw-Deno
  import of `src/core/index.mjs` still fails with the J-009 `roughjs/bin/rough`
  specifier error; that's a Deno resolver quirk against raw source, orthogonal
  to the bundled-pipeline smoke gate.
- Assertions: `<svg` present, `<rect` present, `<path` present, no literal
  `undefined` in output. 1 test, ~190 ms under `deno test` (Deno 2.5.6,
  Apple Silicon). First run also downloads `jsr:@std/assert` 1.0.19.
- Complementary `tests/js/bundle-smoke.test.mjs` (vitest) is an
  existence/size gate: fails if `dist/core.mjs` is missing or <10 MB. Its
  only purpose is to catch forgotten `make core` runs before `npm test`.
  It does NOT exercise the runtime — the bundle is `--platform=neutral`
  with Deno-host assumptions (`location`, `fetch`, etc.) and running it
  under plain Node is not supported.
- Makefile: added `deno-test` target (depends on `core`), added to `test`
  prerequisites alongside `audit`. `make test` now runs
  core → audit → deno-test → vitest → cargo test → parity.
- Smoke output head: `<svg height="140" width="420.08096678629516" viewBox="0 0 420.08096678629516 140`.

---

## T — Phase 2: Text and metrics

### T-001 — `src/core/text-metrics.mjs` — `FontkitTextMetricsProvider`
**Status:** `done` **Deps:** J-008, FNT-002
**Ref:** `PLAN.md` §4A.2
**Acceptance:**
- Class exposes `getLineWidth(text, fontString)`.
- Lazily loads a fontkit `Font` from a base64 WOFF2 via `fontkit.create(buf)`; caches per family.
- Parses `"<N>px <family>, …"` — captures `N` and the first family name only.
- Unit test: `getLineWidth("Hello", "20px Excalifont") > 0` and within ±20% of the string-length heuristic.

### T-002 — Font-string parser
**Status:** `done` **Deps:** none
**Files:** inside `src/core/text-metrics.mjs`
**Acceptance:**
- `parseFontString("20px Virgil, Segoe UI Emoji")` → `{ pxSize: 20, family: "Virgil" }`.
- Handles: integer px, fractional px, quoted family names (`'Comic Shanns'`), extra whitespace.
- Unit tests cover at least 6 real scenes' font strings.

### T-003 — Wire canvas shim to fontkit provider
**Status:** `done` **Deps:** J-005, T-001
**Ref:** `PLAN.md` §4.2, upstream `SVG_EXPORT.md` §3.2
**Acceptance:**
- `document.createElement("canvas").getContext("2d").measureText(text).width` returns the fontkit-measured width for the current `font` string.
- Changing `font` between calls changes the measured width.
- Same `FontkitTextMetricsProvider` instance is shared with T-004.

### T-004 — Register provider via `setCustomTextMetricsProvider`
**Status:** `done` **Deps:** T-001, J-008
**Ref:** upstream `SVG_EXPORT.md` §3.2
**Acceptance:**
- `src/core/index.mjs` imports and calls `setCustomTextMetricsProvider(provider)` from `@excalidraw/element/textMeasurements` once.
- Without this call, text-wrapped fixture wraps at wrong width (sanity regression test).

**Notes (completion):**
- **Acceptance path correction.** `@excalidraw/element/textMeasurements` is a
  monorepo-internal package alias; the npm dist of `@excalidraw/excalidraw`
  (0.18.1) is a single bundled package whose `exports` map only surfaces the
  root `.` and types via `./*`. There is no `element/textMeasurements`
  subpath. Verified by reading
  `node_modules/@excalidraw/excalidraw/package.json`.
  `setCustomTextMetricsProvider` IS re-exported from the package root
  (`dist/prod/index.js` last line, renamed `DT`), so the registration is
  performed via the existing dynamic `import("@excalidraw/excalidraw")`
  inside `loadExportToSvg()`.
- Registration fires exactly once (the Promise is cached) and passes the
  `getSharedTextMetricsProvider()` singleton — the same instance the T-003
  canvas shim delegates to — so the two metric paths (provider-hook and
  direct canvas) stay coherent.
- Soft guard: call is wrapped in a `typeof mod.setCustomTextMetricsProvider
  === "function"` check. Excalidraw could tree-shake it out in a minor
  version; in that case `CanvasTextMetricsProvider` stays the default and
  its `measureText` call still lands on our T-003 canvas shim, so metrics
  remain fontkit-backed. (Effectively Outcome B as a fallback.)
- Verified via new vitest assertion in `tests/js/render.test.mjs` that
  mocks `@excalidraw/excalidraw` and observes a single
  `setCustomTextMetricsProvider` call with the shared provider instance.
  End-to-end: `make core` + Deno load of `dist/core.mjs` renders the
  `text-wrapped` fixture to 2 `<text>` elements, 870×240 viewBox.

### T-005 — Fixture: wrapped text + long text
**Status:** `done` **Deps:** P-003
**Files:** `tests/fixtures/text-wrapped.excalidraw`
**Acceptance:**
- Scene has one text element in Virgil and one in Excalifont; both wrapped inside containers of known widths (300px and 500px).
- File round-trips on excalidraw.com.

**Notes:** hand-crafted by the orchestrator; renders cleanly via bundled `dist/core.mjs` — 2 `<text>` elements, viewBox `0 0 870 240`. Excalidraw.com round-trip not yet manually verified; flag if downstream T-006 fails structurally.

### T-006 — Line-wrap parity gate (§4A.2)
**Status:** `done` **Deps:** T-003, T-004, T-005
**Ref:** `PLAN.md` §4A.2, §4A.8 gate 5
**Acceptance:**
- Headless-browser oracle (Playwright + excalidraw.com) renders the fixture; records line break columns per paragraph.
- Our CLI renders the same fixture; line break columns must be within ±1 per line.
- Failure prints both sides for the failing line. Gate blocks Phase 2 completion.

**Notes:** scope reduced to snapshot-based regression gate per orchestrator direction. Full Playwright + excalidraw.com browser oracle is deferred to FNT-005, which needs Playwright anyway — that infra will be reused to upgrade this gate post-landing. The ±1 line per paragraph tolerance from PLAN §4A.2 is reflected in the snapshot, not against a live browser.

- Implementation: `tests/fixtures/text-wrapped.expected.json` (baseline)
  + `tests/js/wrap-regression.test.mjs` (vitest gate).
- How wrap lines manifest in the SVG: upstream
  `renderer/staticSvgScene.ts` splits `element.text` on `"\n"` and emits
  one sibling `<text>` node per line inside the element's group `<g>` —
  NOT `<tspan>` children, NOT multiple `y`/`dy` deltas on one node. The
  gate groups observed `<text>` nodes back into paragraphs by matching
  each first-line's leading chars against the baseline's `firstChars`.
- Observed baseline for `text-wrapped.excalidraw`: 2 `<text>` nodes total
  (one per paragraph), 1 line each, 16736-byte SVG. The fixture stores
  unwrapped `text` (no embedded `\n`), so Excalidraw's export path emits
  one node per paragraph. Tolerances: ±1 line per paragraph, ±10 % SVG
  length — loose enough that Phase 3 FNT metric drift won't trip the
  gate, tight enough to catch catastrophic regressions.
- FNT-005 will upgrade this gate by (a) running the same fixture on
  excalidraw.com in headless Chrome, (b) capturing authoritative line
  break columns per paragraph, (c) replacing the line-count assertion
  with column-level `±1 per line` comparison, and (d) committing a
  genuine browser-oracle baseline alongside the current snapshot.

---

## FNT — Phase 3: Fonts (critical path; see PLAN §4A)

### FNT-001 — `src/scripts/build-font-assets.mjs`
**Status:** `done` **Deps:** P-001
**Ref:** `PLAN.md` §4A.3, §4A.7
**Acceptance:**
- Reads `node_modules/@excalidraw/excalidraw/dist/prod/fonts/` recursively for `*.woff2`.
- Emits `src/core/font-assets.mjs` with a frozen map `family → [{ path, base64, unicodeRange? }]`.
- `unicodeRange` read from Excalidraw's `fonts.css` or per-family descriptors; verbatim.
- Deterministic output (stable ordering) so the file diffs cleanly on dep bumps.
- Running `make fonts` twice on unchanged input produces no diff.

### FNT-002 — `src/core/font-assets.mjs` committed initial version
**Status:** `done` **Deps:** FNT-001
**Acceptance:**
- Generated once, committed. Counts match `node_modules/.../fonts/` byte-for-byte (234 WOFF2s as of Excalidraw 0.18.0).

### FNT-003 — Inventory integrity test (§4A.8 gate 1)
**Status:** `done` **Deps:** FNT-002
**Files:** `tests/js/font-inventory.test.mjs`
**Acceptance:**
- Walks the installed npm font dir, hashes each file, compares to `font-assets.mjs`.
- Fails on extra/missing/modified file; prints diff.
- Included in `make test`.

### FNT-004 — Subset round-trip test per family (§4A.8 gate 2)
**Status:** `done` **Deps:** FNT-002
**Files:** `tests/js/font-subset.test.mjs`
**Ref:** `PLAN.md` §4A.3
**Acceptance:**
- For each supported family (Excalifont, Virgil, Nunito, Lilita One, Comic Shanns, Cascadia, Liberation, Xiaolai): subset to `{'A','B','C'}` through Excalidraw's subset pipeline; assert the resulting WOFF2 parses, has non-empty `hmtx` and `cmap`, and contains glyphs for all 3 codepoints.
- Xiaolai uses CJK codepoints instead of ABC.

### FNT-005 — Browser fidelity test (§4A.8 gate 3)
**Status:** `done` **Deps:** T-006, FNT-004
**Files:** `tests/js/browser-fidelity.test.mjs`, `src/scripts/browser-font-baseline.mjs`, `tests/fixtures/browser-font-baseline.json`
**Ref:** `PLAN.md` §4A.8 gate 3
**Acceptance:**
- Playwright headless-Chrome renders CLI output for a 100-char string in each family.
- Extracts computed text width via `getComputedTextLength()`.
- Baseline widths captured once from a reference excalidraw.com render; committed to `tests/js/fixtures/font-fidelity-baseline.json`.
- Tolerance: ≤2 px per 100-char string.

**Notes (completion):**
- Scope deviation from the original wording (agreed with orchestrator). The
  reference oracle is Chromium's native `canvas.measureText` over a page
  that self-hosts our bundled WOFF2s via `@font-face`, not excalidraw.com.
  Same font bytes ship to both sides, no network, CI-stable. Kept
  `@playwright/test` (chromium only, no firefox/webkit). Baseline length
  reduced to 43 chars (Latin) / 12 chars (CJK); tolerance scales per-char
  (0.02 px/char = 2 px/100 chars) so the PLAN acceptance still holds.
- `getComputedTextLength()` path was dropped in favor of
  `canvas.measureText().width` because Excalidraw's export pipeline uses
  canvas metrics (see `FontkitTextMetricsProvider.getLineWidth`) — the
  apples-to-apples comparison is canvas ↔ canvas.
- Xiaolai test text had to be scoped to a single shard. The family ships
  as 209 per-codepoint shards (no single shard covers an arbitrary CJK
  string), and `FontkitTextMetricsProvider` currently picks one shard per
  query (TODO(FNT-009) in `text-metrics.mjs`). Using a 12-char string
  that lives entirely in shard[20] sidesteps the limitation without
  modifying `src/core/**`. When FNT-009 lands (per-codepoint shard
  routing), this can be upgraded to an arbitrary CJK string.
- Observed deltas across all 8 families are ≤0.0005 px, orders of
  magnitude below the ±0.86 px / ±0.24 px tolerances. fontkit's
  `layout()` applies no shaping features beyond advance widths; Chrome's
  default canvas state matches. No tolerances widened.
- Two artifacts: the Playwright-driven baseline script is NOT run at
  test time (`tests/js/browser-fidelity.test.mjs` reads the committed
  JSON). Regen is an explicit manual step — `npm run baseline:fonts` +
  commit.
- T-006's line-count gate can now be upgraded to column-level parity
  using the same Playwright infra; FNT-011 gains a ready-to-reuse
  canvas-measurement harness for family-fallback round-trips.

### FNT-006 — Mixed-script fixture (§4A.8 gate 4)
**Status:** `done` **Deps:** P-003
**Files:** `tests/fixtures/mixed-script.excalidraw`
**Acceptance:**
- Scene text contains Latin + CJK (via Xiaolai fallback) + emoji (best-effort) in a single text element.
- CLI output shows: Latin glyphs resolve to Excalifont, CJK glyphs to Xiaolai via unicode-range matching.

### FNT-007 — Wrap-parity fixture (§4A.8 gate 5)
**Status:** `done` **Deps:** T-006
**Files:** `tests/fixtures/wrap-400.excalidraw`
**Acceptance:**
- 400-char paragraph at 300 px container width.
- Reference line breaks captured once via excalidraw.com export.
- CLI output must match within ±1 break column per line.

### FNT-008 — Helvetica → Liberation aliasing
**Status:** `done` **Deps:** J-008
**Ref:** `PLAN.md` §4A.5
**Acceptance:**
- Scene with `font-family: Helvetica` renders text with Liberation Sans metrics.
- Emitted SVG `font-family` string still lists `Helvetica` first (so embedded-scene round-trips).

**Notes (completion):** Already working from T-001 — `FAMILY_ALIASES`
routes Helvetica measurements to Liberation Sans in `text-metrics.mjs`.
Upstream Excalidraw writes `font-family="Helvetica, sans-serif, Segoe UI
Emoji"` as-is onto the `<text>` element (no rewrite in our render path).
Added `tests/js/font-helvetica-alias.test.mjs`: renders an inline
fontFamily=2 scene via the bundle, asserts SVG attribute starts with
`Helvetica`, and asserts `getLineWidth("…", "20px Helvetica")` is
bit-identical to `getLineWidth("…", "20px Liberation")` (and distinct
from Excalifont).

### FNT-009 — Unknown family fallback + `--strict-fonts`
**Status:** `done` **Deps:** J-008
**Ref:** `PLAN.md` §4A.5
**Acceptance:**
- By default, unknown numeric family IDs render with Excalifont metrics.
- `opts.strictFonts: true` in the `__render` call rejects with an error listing offending families.
- Rust `--strict-fonts` flag maps to this option (see R-002).

**Notes (completion):** Provider-side fallback to Excalifont was already
wired by T-001 (`FALLBACK_FAMILY` in text-metrics.mjs). Added
`ALLOWED_FIRST_FAMILIES` allowlist + `_collectFirstFamilies(svg)` helper
in `src/core/index.mjs`; `render()` now post-scans the emitted SVG when
`opts.strictFonts === true` and throws
`Error("Unsupported font families in scene: …")` if any first-family is
not in the allowlist. Test fixture uses `fontFamily: 99` — upstream
falls through to "Segoe UI Emoji" as first family, which is not
allowlisted (PLAN §4A.6 local-only), so strict mode rejects. Covered in
`tests/js/font-strict-fonts.test.mjs` (both object-opts and JSON-string
opts paths for R-003 parity).

### FNT-010 — Emoji local-only handling
**Status:** `done` **Deps:** J-008
**Ref:** `PLAN.md` §4A.6
**Acceptance:**
- No `@font-face` is emitted for Segoe UI Emoji.
- The SVG `font-family` string still keeps `Segoe UI Emoji` in the fallback list.
- Documented in README as a known limitation.

**Notes (completion):** Policy verification only — no code changes
required. Upstream's font export path skips families with only
`src: local(...)` descriptors (PLAN §4A.6), so Segoe UI Emoji and
Helvetica never appear in `@font-face`. Empirical finding in
`tests/js/font-emoji-local-only.test.mjs`: `skipInliningFonts: true` in
our `exportToSvg` call does NOT suppress all `@font-face` rules —
Excalifont + Xiaolai still ship as inline data-URL faces in
`<defs><style class="style-fonts">`. The local-only guarantee is
independent of that flag; tests assert the absence of Segoe/Helvetica
`@font-face` specifically. `font-family` attribute on the mixed-script
fixture's `<text>` preserves
`"Excalifont, Xiaolai, Segoe UI Emoji"` including the emoji fallback.
README note deferred to D-001 (the README itself doesn't exist yet).

### FNT-011 — `.excalidraw.svg` font metadata round-trip (§4A.8 gate 6)
**Status:** `done` **Deps:** E-001
**Files:** `tests/js/font-roundtrip.test.mjs`
**Acceptance:**
- Export a scene with `--embed-scene`; decode the base64 payload back.
- Assert every text element's `fontFamily` (numeric) and the family fallback string in SVG `font-family` match the input exactly.

**Notes (completion):**
- Imports `decodePayload(svg)` from E-003's
  `tests/js/embed-scene-roundtrip.test.mjs` rather than inlining a copy —
  the two gates share one decoder (pako-inflate of the compressed bstring
  wrapper). That import causes E-003's own describe block to re-run as a
  side effect under this file, which is harmless and keeps the decoder
  exercised.
- For each of 3 fixtures (`basic-shapes`, `text-wrapped`, `mixed-script`):
  (a) filter non-deleted `type:"text"` elements from the scene, (b) render
  with `embedScene: true`, (c) decode payload, (d) match decoded text
  elements back to originals by `id` and assert `fontFamily` equality,
  (e) scan the rendered SVG for `<text font-family="…">` attributes and
  assert each first-family name is one of the expected names derived from
  `ID_TO_FIRST_FAMILY` (1=Virgil, 2=Helvetica, 3=Cascadia, 5=Excalifont,
  6=Nunito, 7=Lilita One, 8=Comic Shanns, 9=Liberation Sans), and every
  expected name appears at least once.
- Observed: `basic-shapes` has no text → both sides empty (degenerate but
  exercises the payload path). `text-wrapped`: ids `text-virgil` (ff=1) +
  `text-excali` (ff=5); SVG `font-family` values
  `"Virgil, Segoe UI Emoji"` and `"Excalifont, Xiaolai, Segoe UI Emoji"`.
  `mixed-script`: id `text-mixed` (ff=5); SVG `font-family`
  `"Excalifont, Xiaolai, Segoe UI Emoji"`. FNT-008 preservation confirmed
  transitively — Helvetica fallback string would surface as
  `"Helvetica, sans-serif, Segoe UI Emoji"`, already covered by the
  Helvetica-specific test (`font-helvetica-alias.test.mjs`).

---

## I — Phase 4: Images and frames

### I-001 — Image fixture (dataURL)
**Status:** `done` **Deps:** P-003
**Files:** `tests/fixtures/image.excalidraw`
**Acceptance:** Contains a PNG image element with `dataURL` in `files`. Opens cleanly on excalidraw.com.

### I-002 — Cropped image fixture (mask path)
**Status:** `done` **Deps:** P-003
**Files:** `tests/fixtures/image-cropped.excalidraw`
**Acceptance:** Image with non-trivial crop that exercises the `<mask>` code path in `renderer/staticSvgScene.ts`.

### I-003 — Frames fixture
**Status:** `done` **Deps:** P-003
**Files:** `tests/fixtures/frames.excalidraw`
**Acceptance:** Two frames, one with a name that requires truncation (exercises `scene/export.ts:69`), children clipped to frame bounds.

**Notes (completion):**
- Two frames with name "Hi" (short) and a 112-char name (long). Each frame
  contains one child (rectangle, ellipse) whose `frameId` points to its
  parent. Order: frames first, then children.
- Verification via bundled `dist/core.mjs` under Node:
  `<clipPath>` count = 2 (one per frame, confirms clipping path), short
  label `>Hi<` renders literally, long label is truncated from 112 chars
  to `"A deliberately long frame label..."` (34 chars). The truncation
  path uses three ASCII dots `...`, not the Unicode `…` character — the
  task's regex accepts either via its `||` fallback.
- `<rect>` count = 5 (1 from the child rectangle + 2 per frame for header
  background + one additional emitted by the SVG scaffolding); `<ellipse>`
  count = 0 because roughjs renders the ellipse child as two `<path>`
  elements.
- The long label exercises `scene/export.ts:69`'s direct
  `canvas.measureText` call (fontkit-backed via the T-003 shim), confirming
  that non-text-element label measurement also routes through our provider.

### I-004 — Images + frames smoke tests
**Status:** `done` **Deps:** J-012, I-001, I-002, I-003
**Acceptance:**
- CLI output for each fixture is valid SVG.
- Output contains `<image href="data:image/...">` with non-empty `href`.
- Cropped fixture output contains a `<mask>` or `<clipPath>` referenced by the image.
- Frames fixture clips children: a `<clipPath>` with the frame's bounds exists and is referenced.

---

## E — Phase 5: Editable `.excalidraw.svg`

### E-001 — `--embed-scene` wiring
**Status:** `done` **Deps:** J-008
**Ref:** `PLAN.md` §4.4, upstream `SVG_EXPORT.md` §3.5
**Acceptance:**
- `__render(scene, { embedScene: true })` sets `appState.exportEmbedScene = true`.
- Output SVG contains `<!-- svg-source:excalidraw -->`, `<metadata>`, `<!-- payload-start -->…`, `<!-- payload-end -->` in the documented order.

**Notes (completion):**
- Pipeline already wired via `src/core/index.mjs` (J-008): `opts.embedScene`
  folds into `appState.exportEmbedScene`. No code change needed.
- Test added at `tests/js/embed-scene.test.mjs` (4 cases). Sanity-run on
  `basic-shapes.excalidraw` confirmed all four markers present in the
  `embedScene: true` output; `<metadata>` appears exactly once.
- Upstream clarification
  (`/Users/rickard/oss/excalidraw/packages/excalidraw/scene/export.ts:364,374`):
  `<!-- svg-source:excalidraw -->` and the (possibly empty) `<metadata>`
  element are emitted **unconditionally**. Only `payload-start`,
  `payload-end`, and the base64 body between them are gated on
  `exportEmbedScene`. The "without embedScene" assertion was tightened to
  reflect that: plain SVG must not contain `payload-start` / `payload-end`,
  but an empty `<metadata />` is acceptable.
- Boundary with E-002 / E-003 documented in the test header: E-001 only
  confirms marker presence; E-002 owns linkedom serialization fidelity of
  the `<metadata>` children; E-003 owns the base64 decode + deep-equal
  round-trip.

### E-002 — linkedom metadata serialization test
**Status:** `done` **Deps:** E-001
**Files:** `tests/js/metadata-serialization.test.mjs`
**Ref:** `PLAN.md` §11 risk 6
**Acceptance:**
- Regex `/<!-- payload-start -->\s*(.+?)\s*<!-- payload-end -->/s` matches the output and captures non-empty base64.
- If linkedom collapses/reorders children, task is reopened with a mitigation plan (manual string injection).

### E-003 — Round-trip test
**Status:** `done` **Deps:** E-001
**Files:** `tests/js/embed-scene-roundtrip.test.mjs`
**Acceptance:**
- For each fixture: `__render(scene, { embedScene: true }).svg` → extract base64 → `decodeSvgBase64Payload` from `@excalidraw/excalidraw/data/encode` → deep-equal original `elements` and `files` (ignoring `source` field).
- Passes for basic, text-wrapped, mixed-script, image, frames fixtures.

**Notes (completion):**
- Decoder path: **hand-rolled** per upstream `data/encode.ts`. The npm dist
  of `@excalidraw/excalidraw@0.18.1` ships a single bundled package whose
  `exports` map only surfaces the root `.` (and types via `./*`) — there is
  no `./data/encode` subpath, and `decodeSvgBase64Payload` is not re-exported
  from the root. Pipeline: extract base64 between `<!-- payload-start -->` /
  `<!-- payload-end -->`; `atob` to wrapper JSON; `JSON.parse`;
  `wrapper.encoded` is a byte string of the pako-deflated UTF-8 scene JSON
  (`compressed=true` branch of upstream `decode()`); `Uint8Array.from(…,
  c => c.charCodeAt(0))`; `pako.inflate(bytes, { to: "string" })`;
  `JSON.parse` to final `{ type, version, source, elements, appState, files }`.
- `pako@2.0.3` is reachable via `node_modules/` as a transitive of
  `@excalidraw/excalidraw` — no new dependency.
- Assertions deliberately narrowed per task spec and PLAN §11 risk 4:
  element count, per-index `{id, type}`, and byte-level
  `JSON.stringify(files)` equality. Full element deep-equal is NOT
  asserted because upstream `restoreElements` (applied on reopen) fills
  derived fields — `version`, `versionNonce`, `lineHeight` defaults, etc.
  — that the hand-authored fixtures do not carry. Those are expected
  deviations, not regressions.
- All 5 fixtures (`basic-shapes`, `text-wrapped`, `mixed-script`, `image`,
  `frames`) round-trip cleanly. `image.excalidraw` exercises the `files`
  path; the other four have empty-array or empty-object `files` which
  still compare byte-equal after `JSON.stringify`.
- `decodePayload(svg)` is exported from the test module so FNT-011 can
  reuse the decoder verbatim for its font-metadata round-trip gate.

---

## R — Phase 6: Rust shell

### R-001 — `crates/excalidraw-image/Cargo.toml`
**Status:** `done` **Deps:** P-001, F-002
**Ref:** `PLAN.md` §5.1, §5.6
**Acceptance:**
- Dependencies: `deno_core` (pinned version from F-003), `tokio` (`rt`, `macros`), `serde`, `serde_json`, `serde_v8`, `anyhow`, `clap` (or `lexopt` — pick in §5.2).
- `[profile.release]`: `lto = "fat"`, `codegen-units = 1`, `strip = "symbols"`, `panic = "abort"`, `opt-level = "z"`.
- Crate metadata: `name = "excalidraw-image"`, description, license MIT, repository, keywords.

### R-002 — `src/argv.rs` — argv parser
**Status:** `done` **Deps:** R-001
**Ref:** `PLAN.md` §5.4
**Acceptance:**
- Flags implemented: `-o/--output`, `--format`, `--embed-scene`, `--no-background`, `--dark`, `--padding`, `--scale`, `--frame`, `--max`, `--skip-font-inline`, `--strict-fonts`, `-h/--help`, `-v/--version`.
- `Args::opts_json()` serializes to the JSON shape `__render` expects (see J-008).
- Unit tests cover: stdin input (`-`), stdout output (`-`), `--format` inference from extension, conflicting flags error out.

### R-003 — `src/engine.rs` — `deno_core` wrapper
**Status:** `done` **Deps:** R-001
**Ref:** `PLAN.md` §5.2
**Acceptance:**
- `Engine::new()` creates a `JsRuntime` with `NoopModuleLoader` and loads `include_str!(concat!(env!("OUT_DIR"), "/core.mjs"))`.
- `Engine::render(scene, opts)` evaluates the trampoline, awaits the promise, deserializes `{ svg: String }` via `serde_v8`.
- Integration test loads the bundled `core.mjs`, renders `basic-shapes.excalidraw`, asserts output starts with `<svg`.

### R-004 — `src/main.rs`
**Status:** `done` **Deps:** R-002, R-003
**Ref:** `PLAN.md` §5.3
**Acceptance:**
- Reads input from file or stdin; writes output to file or stdout.
- Uses `#[tokio::main(flavor = "current_thread")]`.
- Exits 0 on success, 1 on parse/render error (with message to stderr), 2 on argv errors.

**Notes (completion):**
- Wired per PLAN §5.3 sketch. `main` is a thin wrapper that maps a
  two-variant `RunError` (Argv → 2, Runtime → 1) onto process exit codes.
- `argv::parse` now returns `Result<Args, ArgvError>` with a single
  `Parse` variant; kept as an enum rather than a bare `anyhow::Error` so
  R-008's error-code branching is type-safe. `--help` and `--version`
  still exit 0 from inside the parser (simpler than a Result<Action>
  enum for v1; flagged in PLAN §5.4 as acceptable).
- PNG output is explicitly rejected with a clear message pointing at
  PNG-001 (Phase 7). SVG output writes raw bytes with no trailing newline
  so parity (R-007) with Deno's `Deno.stdout.write(...)` is byte-clean.
- Stdin path (`-`) tested end-to-end via R-008's `broken_json_exits_one`
  and `js_side_error_surfaces_message` harnesses.

### R-005 — `build.rs` — copy `dist/core.mjs` + fonts into `OUT_DIR`
**Status:** `done` **Deps:** J-010, FNT-002, R-001
**Ref:** `PLAN.md` §5.9
**Acceptance:**
- `build.rs` copies `../../dist/core.mjs` to `OUT_DIR/core.mjs`.
- Generates `OUT_DIR/embedded_fonts.rs` with a `static EMBEDDED_FONTS: &[(&str, &[u8])]` table built from `src/core/font-assets.mjs`.
- Re-runs on change of `core.mjs` or `font-assets.mjs` (via `cargo:rerun-if-changed`).
- Also mirrors to `crates/excalidraw-image/assets/` for `cargo publish` self-containment.

### R-006 — Single-fixture smoke test
**Status:** `done` **Deps:** R-004, R-005
**Files:** `crates/excalidraw-image/tests/smoke.rs`
**Acceptance:** `cargo test -p excalidraw-image smoke` runs the binary against `basic-shapes.excalidraw`, asserts SVG output.

**Notes (completion):**
- Landed at `crates/excalidraw-image/tests/smoke.rs`, not repo-level
  `tests/rust/smoke.rs` (PLAN §7's original layout). Cargo integration
  tests must live inside the owning crate, so `tests/rust/` is repurposed
  for non-crate harness files (today, `deno-run.mjs`).
- Uses `env!("CARGO_BIN_EXE_excalidraw-image")` so the test depends on a
  fresh build automatically. No rebuild logic needed.
- Assertions are intentionally minimal (exit 0, starts with `<svg`, has a
  `<rect>` or `<path>`, no literal `undefined`). Rendering correctness is
  the parity gate's (R-007) job.

### R-007 — Parity gate: Deno vs Rust byte-identical output (§8.2)
**Status:** `done` **Deps:** R-006, J-012
**Files:** `crates/excalidraw-image/tests/parity.rs`, `tests/rust/deno-run.mjs`
**Ref:** `PLAN.md` §8.2
**Acceptance:**
- For every fixture in `tests/fixtures/`: spawn `deno run src/core/dev.mjs <fixture>`, run `cargo run -- <fixture>`, assert **byte-equal** stdout.
- If a host-specific difference is unavoidable (e.g., RNG seeding), the Deno and Rust hosts share a seed via env var or the JS core takes a deterministic seed from opts.
- Gate runs in CI on every PR.

**Notes (completion):**
- Deno side does NOT use `src/core/dev.mjs` — that file imports
  `src/core/index.mjs`, which dynamic-imports `@excalidraw/excalidraw`,
  which fails under raw Deno (J-009's roughjs resolver quirk). The
  parity driver `tests/rust/deno-run.mjs` imports `dist/core.mjs` — the
  same bytes `build.rs` embeds in the Rust binary. Diffing
  bundled-Deno vs bundled-Rust is the sharpest signal.
- Driver uses `Deno.stdout.write` in a loop: macOS short-wrote ~207 B
  per call on pipe destinations. Missing the loop silently truncated
  Deno output and caused spurious parity failures.
- Two host-leak findings discovered by the gate and fixed in the Rust
  bootstrap (`engine.rs::PRE_CORE_BOOTSTRAP`), NOT by widening
  tolerances (TASKS appendix rule):
  1. `crypto.getRandomValues` — Deno provides real crypto; `deno_core`
     does not. `frames.excalidraw` reaches a nanoid ID generator and
     Rust threw `ReferenceError`. Fixed by adding a deterministic
     xorshift32-backed polyfill. Verified empirically: none of the
     current fixtures emit these bytes into the SVG, so Deno's real
     randomness and Rust's deterministic values coincidentally produce
     byte-identical output. If a future fixture leaks these bytes, the
     gate will flag it and the fix is to polyfill on the Deno side too.
  2. `Deno.stdout.write` partial-write behaviour (above).
- Parity pass per fixture (final):
  - `basic-shapes.excalidraw` — 1,777 B, identical.
  - `frames.excalidraw` — 3,256 B, identical.
  - `image.excalidraw` — 622 B, identical.
  - `image-cropped.excalidraw` — 1,129 B, identical.
  - `mixed-script.excalidraw` — 11,925 B, identical.
  - `text-wrapped.excalidraw` — 16,736 B, identical.
  - `wrap-400.excalidraw` — 10,347 B, identical.
- `make parity` now `cargo test -p excalidraw-image --release --test
  parity` (depends on `core`). Replaces the "not-yet-implemented"
  placeholder.

### R-008 — Error handling and exit codes
**Status:** `done` **Deps:** R-004
**Files:** `crates/excalidraw-image/tests/errors.rs`, `crates/excalidraw-image/src/main.rs`, `crates/excalidraw-image/src/argv.rs`
**Acceptance:**
- Invalid JSON input: exit 1, stderr starts with `error: failed to parse`.
- Missing file: exit 1, stderr mentions the path.
- Unknown flag: exit 2, stderr prints `--help`.
- JS-thrown error: exit 1, stderr includes the JS error message (not just `Error: undefined`).

**Notes (completion):**
- `argv.rs` gained an `ArgvError::Parse` enum variant so main.rs can
  branch on exit code without string-matching. Today there's only one
  variant; the shape is kept for a future `Help` / `Version` path if we
  ever move those out of `std::process::exit(0)` inline.
- `main.rs` wraps argv errors as `RunError::Argv` (exit 2) and runtime
  errors (missing file, JSON parse, render failure) as
  `RunError::Runtime` (exit 1). All runtime messages flow through
  `anyhow::Context`, producing the required `error: failed to …`
  prefix on stderr.
- Harness at `crates/excalidraw-image/tests/errors.rs` covers the 4
  acceptance cases. The JS-error case feeds a valid-JSON-but-wrong-shape
  scene via stdin (`elements: "not-an-array"`) to trigger a throw deep
  in `exportToSvg`; asserts exit=1, stderr starts with `error:`, and
  `error: undefined` does NOT leak through.
- Unknown-flag test also asserts the stderr body mentions `--help` or
  `Usage`. main.rs prints both `error:` and a `run \`excalidraw-image
  --help\` for usage.` hint on argv errors.

---

## PNG — Phase 7: PNG via native `resvg`

### PNG-001 — `src/raster.rs` — `resvg` integration
**Status:** `done` **Deps:** R-004, R-005
**Ref:** `PLAN.md` §5.5
**Acceptance:**
- `raster::svg_to_png(svg, args) -> Result<Vec<u8>>`.
- Builds `fontdb::Database` from `EMBEDDED_FONTS` (R-005).
- Honors `args.scale` and `args.max`.
- Returns deterministic PNG bytes (same input → same output).

**Notes (completion):**
- Embedding strategy: **Option Y** (single concatenated `embedded_fonts.bin`
  + offset/length tuples), not Option X (per-font `include_bytes!`). Reason
  is forced, not stylistic: `fontdb::Database::load_font_data` only accepts
  raw TTF/OTF — passing WOFF2 bytes silently produces zero faces (verified
  empirically by `font_dump` debug test before deletion). build.rs must
  decompress WOFF2 → TTF, which means writing bytes anyway, so a single
  blob with one `include_bytes!` is cleaner than 234 absolute-path
  `include_bytes!` sites.
- WOFF2 decoder picked: `woofwoof = "1"` (Google's C++ woff2 + pure-Rust
  brotli). Tried `woff2 = "0.3"` (compile-fails against current
  `safer-bytes`), `woff2-patched = "0.4"`, and `woff2-no-std = "0.3"`
  (both panic with `Stream truncated` deep in their `glyf` decoder on
  Excalidraw's Assistant-Bold.woff2). woofwoof decoded all 234 shards
  cleanly. Adds a C++ build-time dep — fine for current macOS build;
  Phase 8 cross-compile may need an alternative if `cc` won't bridge to
  the target.
- Slicing into a `&[u8]` is not yet const-stable (rust-lang/rust#143874),
  so the generated table is `EMBEDDED_FONT_INDEX: &[(&str, usize, usize)]`
  + `EMBEDDED_FONTS_BLOB: &[u8] = include_bytes!(…)`.
  `raster::iter_embedded_fonts()` materializes `(&str, &[u8])` at runtime.
- resvg/usvg/tiny-skia versions pinned at the 0.45 / 0.11 series — the
  PLAN §5.5 sketch was written against that API. 0.47 is the latest but
  was not needed.
- `RasterOptions { scale, max }` carries the subset of `Args` that affects
  rasterization. Other rendering opts (dark, padding, frame, …) flow
  through the JS render step into the SVG.

### PNG-002 — `--format png` end-to-end
**Status:** `done` **Deps:** PNG-001, R-002
**Acceptance:**
- `excalidraw-image fixture.excalidraw -o out.png` writes a valid PNG.
- `file out.png` reports `PNG image data`.
- `identify out.png` width/height match the fixture's bounding box at `args.scale`.

**Notes (completion):**
- `main.rs` previously rejected `Format::Png` with a "not yet implemented"
  message; that branch is now `raster::svg_to_png(&result.svg, …)`.
- argv extension inference (`.png` → `Format::Png`) was already in place
  from R-002 — verified by the existing `format_inferred_from_output_ext_png`
  test. No new argv work needed.
- Smoke harness at `crates/excalidraw-image/tests/png.rs`: 3 tests
  covering `-o foo.png` (extension inference), explicit `--format png` to
  stdout, and the text-rendering path (which is the canary for fontdb
  silently coming up empty — if WOFF2→TTF decompression broke, this test
  flags it via PNG file size).

### PNG-003 — PNG fixtures and snapshot
**Status:** `todo` **Deps:** PNG-002
**Files:** `tests/fixtures/*.png.snapshot` (binary golden)
**Acceptance:**
- Golden PNGs generated once; test diffs via pixel-match (tolerance ≤1 per 100k pixels).
- Covers: basic shapes, text, image, frames.

### PNG-004 — PNG font fidelity
**Status:** `todo` **Deps:** PNG-001, FNT-005
**Acceptance:** `resvg` picks the correct bundled WOFF2 for each text element via `fontdb` matching. Compare rendered text region against a headless-browser PNG of the same scene: SSIM ≥ 0.95.

---

## SZ — Phase 8: Size + cross-compile

### SZ-001 — Cross-compile matrix via `cross` or per-OS runners
**Status:** `todo` **Deps:** R-007
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
**Status:** `done` **Deps:** R-007, PNG-002
**Files:** `README.md`
**Acceptance:**
- Install section: `brew install`, `cargo install`, GH Release download.
- Quickstart: 3 invocations (SVG, embedded SVG, PNG).
- CLI reference (generated from `--help` or kept in sync manually).
- Fidelity caveats: line-wrap ±1 char, emoji not guaranteed, sub-pixel divergence from web app.
- Link to `PLAN.md` for architecture, `SVG_EXPORT.md` for the deep dive.

### D-002 — `--help` polish
**Status:** `done` **Deps:** R-002
**Acceptance:** Output fits in 80 cols; grouped (Inputs / Outputs / Rendering / Fonts); includes an examples section.

**Notes:** EXAMPLES section added in argv.rs covering stdout, file output, format inference, embed-scene round-trip, scale+max, stdin pipe.

### D-003 — Fidelity caveats doc
**Status:** `done` **Deps:** FNT-005, PNG-004
**Files:** `docs/fidelity.md`
**Acceptance:** Documents expected divergences from web-app output and why. Links to relevant PLAN sections.

**Notes (completion):** Landed without waiting for PNG-004 to ship. PNG
fidelity is documented as authoritative-as-of-today: text wrapping is
exact (SVG already has one `<text>` per wrapped line), but glyph
horizontal-advance through `resvg` may sub-pixel-drift from a
Chromium-rendered SVG. The PNG-004 SSIM ≥ 0.95 gate is listed under "Known
issues / open follow-ups" so the doc is honest about what is and isn't
locked yet. Re-visit when PNG-004 lands and tighten the language if the
SSIM measurement reveals anything unexpected.

### D-004 — Fixture snapshot baseline
**Status:** `done` **Deps:** R-007
**Acceptance:** All `tests/fixtures/*.excalidraw` have committed golden `.svg` (and `.png` for Phase 7 fixtures). `vitest -u` and `cargo insta review` workflows documented in README.

**Notes:** 7 SVG goldens committed (45 KB total). Regen via `make goldens` / `node src/scripts/regen-goldens.mjs`. Gate test at `tests/js/svg-goldens.test.mjs`. PNG goldens defer to PNG-003.

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
