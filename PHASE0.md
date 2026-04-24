# Phase 0 Decisions — `excalidraw-image`

Written after F-001 and F-002 completed. This doc locks the Phase 0 outputs
listed in `TASKS.md` F-003. Delete or fold into the README at v1 launch.

## Verdict

**The architecture described in PLAN.md §1–§5 is feasible as-is.** Both
spikes pass their acceptance gates. Proceed to Phase 1 (J-series) and
Phase 6+ (R-series) without architectural changes.

## Locked decisions

### 1. Consumption strategy — **package-root npm bundle** (not vendored source)

F-001 verified that esbuild can bundle `@excalidraw/excalidraw` from the
published npm dist (`node_modules/@excalidraw/excalidraw/dist/prod/index.js`
reachable via `import { exportToSvg } from "@excalidraw/excalidraw"`) down
to 4.13 MB raw / 3.18 MB minified, with no forbidden editor/React/i18n
paths in the final input graph.

Fallback plan (vendored source from a pinned upstream checkout) is
**not needed** and can be dropped from the risk register for v1.

### 2. `deno_core` version — **pinned at `0.399.0`**

Not `0.318` as PLAN.md originally said. F-002 found `0.399.0` is the
current stable release. `serde_v8` is re-exported from `deno_core` — no
separate pin needed.

API notes (see PLAN.md §5.2 for updated code):

- `rt.handle_scope()` replaced by `deno_core::scope!` macro.
- `rt.resolve_value(promise)` deprecated → `rt.resolve(promise)` +
  `rt.with_event_loop_promise(...)`.
- `rt.execute_script` is **classic-script**, not ES module. Means our
  bundle's `import.meta.*` sites must be stripped at esbuild time via
  `--define`. J-010 must do this; today the spike does it manually.

### 3. PNG in v1 — **yes**, via native `resvg` (not WASM)

Rust shell exists from day one (not v2), and `resvg` is essentially free
to add once we have a Rust crate. No further gating needed — PNG lands in
Phase 7 (§9).

### 4. Binary size budget — **50 MB target**, **60 MB hard cap**

F-002 measured 43.6 MB on macOS arm64 with `lto = fat`, `opt-level = z`,
`strip = symbols`. That includes `deno_core` + `rusty_v8` + our 4 MB JS
bundle. Adding `resvg` (~6 MB) and the 16.69 MB base64 font map will push
it up, but embedded fonts compress well and v8 is the dominant weight.
**Revised budget (informational):**

| Component | Spike | v1 projection |
|---|---:|---:|
| `deno_core` + `rusty_v8` + V8 snapshot | ~30 MB | ~30 MB |
| JS bundle (`core.mjs` minified) | 3.2 MB | 3–5 MB (with polyfills) |
| Embedded fonts (base64 in JS) | — | +12–17 MB raw, much less after strip |
| `resvg` + `usvg` + `fontdb` | — | ~6 MB |
| Misc (`tokio`, `serde`, `anyhow`) | <2 MB | ~2 MB |
| **Total** | **43.6 MB** | **~50 MB** |

SZ-002 records this as a regression budget.

### 5. Cold start — **80 ms** observed; keep under **400 ms**

F-002 measured 80 ms median (5 runs) on a small scene. We have ample
headroom. If it degrades below 400 ms during Phase 3 (font subsetting),
investigate a V8 startup snapshot (`deno_core` supports this).

## Findings that change downstream tasks

### Finding A: **esbuild alias list is larger than PLAN §5.7 originally listed**

F-001 needed Proxy-backed stubs for, in addition to the PLAN's React/Jotai/CSS
entries:

- `@excalidraw/mermaid-to-excalidraw` (pulls in `mermaid` → `vscode-jsonrpc` → node built-ins)
- `@radix-ui/*` family (wildcard; use an esbuild plugin)
- `jotai-scope`
- `react/jsx-runtime`, `react/jsx-dev-runtime`
- 54 `dist/prod/locales/*.js` dynamic imports (~1.7 MB savings)

**Stub must be a callable `Proxy`**, not `{}`. Code uses `Object.assign`
and destructuring on imported symbols. Working implementation is in
`spike/shims.mjs` → `makeProxy()`.

**Impact on tasks:** J-010 (esbuild build script) must match this list.
PLAN.md §5.7 step 2 has been updated.

### Finding B: **Bundle is NOT host-neutral for deno_core**

F-002 discovered Deno silently provides many Web-platform globals that
`deno_core`'s default runtime does not. The bundle runs in Deno but fails
in `deno_core` without polyfills for:

- `atob`, `btoa` — already shimmed by J-002 (base64).
- `URL`, `URLSearchParams`
- `TextEncoder`, `TextDecoder`
- `Event`, `EventTarget`
- `DOMException`
- `performance` (at minimum `performance.now()`)
- `setTimeout`, `clearTimeout`, `setInterval`, `clearInterval`

**Decision: polyfill in JS, not via `deno_core` extensions.** Reasoning:

1. Single source of truth — one shim, runs identically under Deno and
   `deno_core`. Parity gate (R-007) stays meaningful.
2. Deno's native implementations and `deno_core` extensions
   (`deno_webidl`/`deno_url`/`deno_web`) may diverge in subtle ways; JS
   polyfills keep both hosts on the same code.
3. Avoids additional Rust deps and feature flags.

Polyfills live in `src/core/shims/web-globals.mjs` (new). J-002 is
renamed/expanded to cover this — see TASKS.md update.

**Cost:** ~2–4 KB added to the bundle; negligible.

### Finding C: `devicePixelRatio` read at module-eval time

Non-blocking but real. The renderer chunk reads `globalThis.devicePixelRatio`
during module evaluation. A new `shims/device.mjs` installs
`devicePixelRatio = 1` defensively. Integrated into the install order:

```
device → web-globals → dom → fonts → fetch-fonts → canvas → workers
```

### Finding D: `load_main_es_module_from_code` swallows synchronous throws

`deno_core` ES-module loading returned `Ok` even when the module threw a
`ReferenceError` during evaluation. Switched to classic-script eval
(`rt.execute_script`). This hides real errors and makes debugging harder —
workaround for now is aggressive logging in shims plus
`--source-map=inline` on the bundle.

**Impact:** R-003 (engine wrapper) uses classic-script eval. If this
blocks real error-reporting later, consider adding a custom
`deno_core::Extension` that wraps evaluation with proper error capture.

## Residual open items

- **Font subsetting under `deno_core`** — F-002 did not exercise Excalidraw's
  `Fonts.generateFontFaceDeclarations()`. The subset path uses `wawoff2` +
  `fonteditor-core`; both are pure JS and should run unchanged, but Phase 3
  (FNT-004/FNT-005) is where this gets validated.
- **Image-embedded fixtures** — basic-shapes has no image elements. `data:`
  URL handling in the `fetch` shim is unexercised. Phase 4 covers this.
- **V8 startup snapshot** — not attempted in F-002. `deno_core` supports
  compile-time snapshots that could cut cold start to <20 ms. Defer until
  we see a real cold-start problem.

## Files produced by Phase 0

- `spike/` — F-001 deliverables (git-tracked, excluding `core.mjs` +
  `meta.json`). Consumed by F-002 via `include_str!` on the regenerated
  `spike/core.mjs`.
- `spike-rust/` — F-002 deliverables (git-tracked, excluding `target/`).
- Updated PLAN.md §4.2, §5.2, §5.7 to reflect findings A–D.
- Updated TASKS.md with expanded J-002 scope and new install-order note.

Both spike directories stay in the tree until Phase 6 lands — they are
the reference implementations for R-001 and J-010. Delete both at v1
release prep.
