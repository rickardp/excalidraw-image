# F-002 spike — embed `core.mjs` in Rust via `deno_core`

Feasibility gate for the `excalidraw-image` project, Rust side. This directory
answers one question: can we take F-001's `spike/core.mjs` bundle, load it into
a statically-linked `deno_core` binary, and produce **byte-identical** output
to the Deno dev-loop host, under the original size and cold-start budgets?

**Verdict: hypothesis holds, with caveats.** See Verdict below.

## Layout

| File                | Role |
|---------------------|------|
| `Cargo.toml`        | Pins `deno_core = "0.399"` (latest stable as of 2026-04-24). Release profile matches the optimized binary profile used by the main crate. |
| `src/main.rs`       | Minimal host: loads bundle, stashes scene JSON on `globalThis`, calls `__render`, awaits, prints the SVG. |
| `src/polyfills.js`  | Spike-only JS polyfills for globals Deno ships but `deno_core` does not (atob/btoa, DOMException, URL, TextEncoder/Decoder, Event/EventTarget, performance, setTimeout). |
| `target/`           | `cargo build` output (gitignored). |

## How to reproduce

```sh
# from repo root
node spike/build.mjs                                      # regenerate spike/core.mjs
deno run --allow-read spike/dev.mjs \
    tests/fixtures/basic-shapes.excalidraw > /tmp/spike-deno.svg
cd spike-rust
cargo build --release
./target/release/spike-rust \
    ../tests/fixtures/basic-shapes.excalidraw > /tmp/spike-rust.svg
diff /tmp/spike-deno.svg /tmp/spike-rust.svg               # (empty = pass)
shasum -a 256 /tmp/spike-deno.svg /tmp/spike-rust.svg
```

Expected SHA-256 of both: `21d5511f5e79928e8a9b30f9a71279722b562a969626a625666fdb3603e26866`.

## Measurements

All measurements taken on macOS Darwin 25.4.0, arm64 (Apple Silicon),
`cargo 1.x` default toolchain, bundle built from `@excalidraw/excalidraw
0.18.1`.

| Metric                                | Value                    | Budget | Pass |
|---------------------------------------|-------------------------:|-----------------:|:----:|
| Release binary size                   | 45,744,528 B = **43.6 MB** | < 60 MB          | yes  |
| Cold-start wall-clock (median of 5)   | **0.080 s = 80 ms**      | < 400 ms         | yes  |
| Output byte-parity vs Deno reference  | **byte-identical**       | byte-identical   | yes  |

Cold-start was measured via `/usr/bin/time -p` on the release binary, five
consecutive runs, all 0.08s. No warm-up, no snapshot.

## deno_core version pinned

- `deno_core = "0.399.0"` (published on crates.io as of the query on
  2026-04-24).
- Transitively drags in `serde_v8 = "0.308.0"` and `v8 = "147.4.0"`.
- `serde_v8` is **re-exported** from `deno_core` as `deno_core::serde_v8`, so
  the spike does not list `serde_v8` as a direct dependency.
- `tokio = "1"` with features `["rt", "macros"]`.
- `serde = "1"` with `derive`.
- `serde_json = "1"`.
- `anyhow = "1"`.

The older reference sketch used `deno_core = "0.318"`. That version is ~18
months old as of 2026-04-24. The API has changed materially (see below), so
the main crate pins **0.399** or newer.

## API deltas vs the prompt's reference code

The prompt's `main.rs` sketch assumed a deno_core API that no longer exists
verbatim. Actual API surface in 0.399.0:

1. **`handle_scope` method is gone.** Replaced by the `deno_core::scope!`
   macro (see `deno_core/examples/eval_js_value.rs` in the released crate).
   Used as:
   ```rust
   deno_core::scope!(scope, &mut rt);
   let local = v8::Local::new(scope, resolved);
   serde_v8::from_v8(scope, local)?
   ```

2. **`resolve_value` is deprecated.** The modern idiom is
   `rt.resolve(promise)` which returns a future that resolves only when the
   promise is already settled — it does **not** pump the event loop on its
   own. To get the old behavior (await the promise while polling the event
   loop), wrap it:
   ```rust
   let resolve = rt.resolve(promise);
   let resolved = rt
       .with_event_loop_promise(Box::pin(resolve), PollEventLoopOptions::default())
       .await?;
   ```

3. **`execute_script` signature.** Takes `(&str name, impl Into<ModuleCodeString>)`.
   A `&str` or `String` for the source works. No change from the prompt.

4. **Classic script vs. ESM.** `execute_script` evaluates as a **classic
   script** — it does not accept `import` / `export` / `import.meta`. The
   F-001 bundle contains five `import.meta.url` / `import.meta.env`
   references that esbuild did not erase. We rewrite them via `String::replace`
   before evaluation. The alternative is to load via
   `load_main_es_module_from_code` + `mod_evaluate`, which this spike tried
   first — see "Surprise findings" below for why that path was abandoned.

## Surprise findings (and what they mean for R-001)

### 1. `deno_core`'s default runtime is *much* smaller than Deno's

`deno_core` with `RuntimeOptions::default()` provides only `console`,
`queueMicrotask`, and `globalThis`. Everything else — `atob`/`btoa`,
`DOMException`, `URL`, `URLSearchParams`, `TextEncoder`/`TextDecoder`,
`Event`, `EventTarget`, `performance`, `setTimeout`, `fetch`, `crypto`,
`structuredClone`, `AbortController`, even `navigator` — is **undefined**
in `globalThis`.

Deno provides all of these via its own "runtime" layer (`deno_webidl`,
`deno_url`, `deno_web`, `deno_fetch`, `deno_console`, `deno_crypto`). The
F-001 spike ran under Deno and never noticed. Under `deno_core` the
bundle fails:

- `ReferenceError: Buffer is not defined` — htmlparser2's static HTML
  entities table is decoded at module-eval time; its decoder falls back to
  `Buffer` when `atob` is missing.
- `ReferenceError: DOMException is not defined` — Excalidraw's
  clipboard/file-error paths reference the class at import time (read by a
  closure, not actually thrown in the basic-shapes path).

**Implication for the production shell.** The "host-neutral JS bundle"
discipline enforced by lint rules is necessary but not sufficient to
guarantee portability — the bundle also tacitly depends on WHATWG globals
that Deno provides but bare V8 does not.
Two options for R-001:

- **(A) JS-side polyfills in `src/core/shims/install.mjs`.** Enumerate the
  required WHATWG globals, install them unconditionally. The bundle becomes
  truly portable. The ESLint host-neutrality rule (`P-002`) should be
  extended to forbid direct reads of `atob`/`DOMException`/etc. outside
  the shims. **Preferred** — keeps all host-portability logic in one place.
- **(B) Host-side extensions.** Pull in `deno_webidl`, `deno_url`,
  `deno_web`, `deno_console`, `deno_crypto`, `deno_fetch` with matching
  versions. Gives byte-for-byte WHATWG behavior, but the version matrix is
  fragile (every `deno_core` bump requires matched bumps of a dozen
  crates). The `rustyscript` crate wraps this up but adds a second major
  dep.

For the **spike** we did option A inline in `src/polyfills.js` (minimal:
only what `basic-shapes` touches). Not production-grade.

### 2. `load_main_es_module_from_code` swallows synchronous module throws

We initially loaded `core.mjs` as an ES module via
`rt.load_main_es_module_from_code(...)` + `rt.mod_evaluate(mod_id)` +
`rt.with_event_loop_promise(...)`. The module threw synchronously during
evaluation (the `DOMException` ReferenceError above), but:

- `mod_evaluate` returned **Ok** (!).
- `globalThis.__render` was undefined.
- A pre-eval sentinel was set; a post-eval sentinel was not.

The error was silent. Only after switching to classic-script `execute_script`
did the error bubble up immediately. This is plausibly a deno_core bug or
simply an API contract I haven't found documented yet. Either way, R-001
should not rely on mod_evaluate's error channel for diagnosis — either
install a `set_promise_reject_callback` handler on the runtime, or keep
using classic-script eval (which requires stripping / rewriting
`import.meta` references, trivial via esbuild `define`).

### 3. Bundle's `import.meta` references

The F-001 bundle uses `import.meta.url` (font-subset worker stub) and
`import.meta.env` (jotai dev-mode checks). Both survive esbuild's default
bundling because the stub plugin and the jotai checks are not dead-coded.
R-001 should add to `src/scripts/build-core.mjs` (task J-010):

```js
define: {
  "import.meta.url": '"file:///excalidraw-image/core.mjs"',
  "import.meta.env.MODE": '"production"',
  "import.meta.env.DEV": "false",
  "import.meta.env.PROD": "true",
  // (existing defines...)
}
```

which makes the bundle evaluable via `execute_script` in classic-script
mode, no post-bundle string rewriting needed.

### 4. stdout trailing newline

The Deno reference (`spike/dev.mjs`) prints with `console.log(svg)` which
adds a `\n`. The spike Rust host uses `println!("{}", svg)` to match. If
R-001 elects to write raw bytes via `std::fs::write` (e.g., for `-o
out.svg`), the contract is that the **JS core returns the SVG without a
trailing newline**; newline-appending is an output-path choice. Document
this in R-004.

## Warnings from `cargo build --release`

None. Clean build.

## Verdict — the original implementation plan acceptance criteria

- [x] **Byte-identical output.** SHA-256 matches Deno reference exactly
  (`21d5511f5e79928e8a9b30f9a71279722b562a969626a625666fdb3603e26866`) on
  `tests/fixtures/basic-shapes.excalidraw`.
- [x] **Release binary < 60 MB.** 43.6 MB.
- [x] **Cold start < 400 ms.** 80 ms median of 5 consecutive runs.

Phase 0 hypothesis for F-002 is **accepted**. Proceed to F-003.

## Notes and recommendations for R-001 / R-003 (real Rust crate)

1. **Pin `deno_core = "0.399"`.** the original implementation plan's `"0.318"` is stale; the API
   has moved. Re-verify on every crate bump (especially `scope!` macro and
   `resolve` / `with_event_loop_promise` shape).

2. **Install WHATWG polyfills in the JS core, not the Rust host.** Add a
   `src/core/shims/whatwg.mjs` that provides `atob`, `btoa`, `DOMException`,
   `URL`, `URLSearchParams`, `TextEncoder`, `TextDecoder`, `Event`,
   `EventTarget`, `performance` before `install.mjs` runs. See
   `spike-rust/src/polyfills.js` for a starter set that works for
   `basic-shapes`; the real list will grow as fixtures with images/fonts
   come online (J-001 through J-008).

3. **Strip `import.meta` at bundle time** via esbuild `define` (J-010) —
   see "Surprise findings" §3 above. Keeps the bundle evaluable as a
   classic script, avoids the `mod_evaluate` error-swallowing trap.

4. **Trampoline pattern works.** Stashing input on `globalThis.__input`
   then evaluating `globalThis.__render(globalThis.__input)` cleanly
   avoids JSON-in-JS-in-Rust quoting issues. Use this as the production
   pattern (`engine.rs` in R-003).

5. **`resolve` + `with_event_loop_promise`** is the correct modern idiom
   for awaiting a promise while pumping microtasks. Use this, not the
   deprecated `resolve_value`.

6. **No ops needed in v1.** All I/O lives in Rust; JS never calls out. The
   spike runs end-to-end with zero extension ops.

7. **Bundle loading strategy.** We `include_str!` the bundle at compile
   time — that works and keeps the binary self-contained. Note that in
   release mode, the 4.1 MB bundle string lives in `.rodata` uncompressed;
   that's already counted in the 43.6 MB budget.

8. **Trailing-newline contract.** Decide at R-004 time: either JS returns
   SVG without `\n` and Rust main.rs appends when writing to a file
   (matches Deno's `console.log` behavior), or JS never has a trailing
   newline and neither does Rust's output. The spike uses the former.

## Known weird things

- **`setTimeout` polyfill routes to `queueMicrotask`.** That's wrong for
  any scene that relies on timer delays, but no path in basic-shapes does.
  R-001's `whatwg.mjs` should use the real `deno_core` timer ops
  (`op_timer_queue`) or a proper polyfill on the Rust side.
- **URL polyfill is not WHATWG-compliant.** It handles `data:` URLs and
  `scheme://host/path` URLs adequately for the spike; sophisticated URL
  inputs will break it. R-001 should use `deno_url` extension or polyfill
  against the `url` crate.
- **`DOMException` is `class extends Error`.** That's technically not
  standard (a DOMException has specific error-code mechanics). Doesn't
  matter for basic-shapes; matters for the image-blob-reduce path, which
  isn't in v1.
