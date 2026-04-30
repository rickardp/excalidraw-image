// R-003 — `deno_core` wrapper for `excalidraw-image`.
//
// Owns a single `JsRuntime` and exposes one async method: `render(scene,
// opts_json) -> { svg }`. The runtime loads the pre-bundled JS core
// (`dist/core.mjs`, copied into OUT_DIR by `build.rs`) once at `new()`; every
// subsequent render reuses the same V8 isolate.
//
// Design notes (from F-002 spike + the feasibility spike notes):
//   * Classic-script eval, NOT ES modules. 0.399's `load_main_es_module_from_code`
//     silently swallows synchronous throws. `execute_script` surfaces them
//     immediately. J-010's esbuild `define` strips `import.meta.*` so the
//     bundle is evaluable in classic-script mode.
//   * `rt.resolve(promise)` returns a future that resolves only when the
//     promise is already settled. It does NOT pump the event loop. We wrap
//     with `with_event_loop_promise` so microtasks + timers fire.
//   * `with_event_loop_promise` requires the future to be `Unpin`, so we
//     `Box::pin` the resolve future before handing it in.
//   * Scene + opts are stashed on `globalThis.__input` / `globalThis.__opts`
//     rather than quoted into the script literal — this avoids
//     JSON-in-JS-in-Rust quoting issues on multi-megabyte scenes.
//   * v8 Value → Rust via the `deno_core::scope!` macro + `serde_v8`
//     (re-exported from `deno_core` in 0.399; no separate crate needed).

use deno_core::{
    serde_v8, v8, JsRuntime, JsRuntimeForSnapshot, PollEventLoopOptions, RuntimeOptions,
};
use serde::Deserialize;

/// Result shape returned by `globalThis.__render(...)`. The JS side also
/// returns a second (optional) field for PNG data in later phases; v1 only
/// reads `svg`.
#[derive(Debug, Deserialize)]
pub struct RenderResult {
    pub svg: String,
}

/// The embedded JS core. `build.rs` copies `dist/core.mjs` into `OUT_DIR`
/// at compile time.
const CORE_MJS: &str = include_str!(concat!(env!("OUT_DIR"), "/core.mjs"));

/// Pre-core polyfill bootstrap. Installs a minimal set of Web-platform
/// globals that the bundle touches at module-eval time — before the
/// bundle's own `src/core/shims/install.mjs` has had a chance to run.
///
/// Necessary because esbuild's bundle groups initializers by module
/// dependency order, and some transitive deps (htmlparser2's entity
/// decoder, pako/inherits, clone.js) reference `Buffer`, `atob`, or
/// `TextEncoder` in module-top-level IIFEs that evaluate BEFORE
/// `src/core/index.mjs`'s `import "./shims/install.mjs"` side-effect.
/// Installing stubs here on `globalThis` guarantees the `typeof X ===
/// "function"` guards in those IIFEs take the shim branch.
///
/// This is a verbatim port of `spike-rust/src/polyfills.js`. The spike
/// validated this exact set against the `basic-shapes` fixture. Kept
/// inline (not `include_str!`d from the spike) so the crate remains
/// self-contained for `cargo publish`.
///
/// Long-term this should live in the JS bundle (via a pre-imported
/// `src/core/shims/bootstrap.mjs`). J-series follow-up; not R-001 scope.
const PRE_CORE_BOOTSTRAP: &str = r#"
(function () {
  const g = globalThis;

  // --- atob / btoa ---------------------------------------------------------
  if (typeof g.atob !== "function") {
    const B64 =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    g.atob = function (input) {
      const s = String(input).replace(/=+$/, "");
      let out = "";
      let buf = 0, bits = 0;
      for (let i = 0; i < s.length; i++) {
        const c = B64.indexOf(s[i]);
        if (c < 0) continue;
        buf = (buf << 6) | c;
        bits += 6;
        if (bits >= 8) {
          bits -= 8;
          out += String.fromCharCode((buf >> bits) & 0xff);
        }
      }
      return out;
    };
    g.btoa = function (input) {
      const s = String(input);
      let out = "";
      let i = 0;
      while (i < s.length) {
        const a = s.charCodeAt(i++) & 0xff;
        const b = i < s.length ? s.charCodeAt(i++) & 0xff : -1;
        const c = i < s.length ? s.charCodeAt(i++) & 0xff : -1;
        const t1 = a >> 2;
        const t2 = ((a & 3) << 4) | (b === -1 ? 0 : b >> 4);
        const t3 = b === -1 ? 64 : ((b & 15) << 2) | (c === -1 ? 0 : c >> 6);
        const t4 = c === -1 ? 64 : c & 63;
        out += B64[t1] + B64[t2] +
          (t3 === 64 ? "=" : B64[t3]) + (t4 === 64 ? "=" : B64[t4]);
      }
      return out;
    };
  }

  // --- DOMException -------------------------------------------------------
  if (typeof g.DOMException !== "function") {
    g.DOMException = class DOMException extends Error {
      constructor(message, name) { super(message); this.name = name || "Error"; }
    };
  }

  // --- Event / EventTarget (minimal) --------------------------------------
  if (typeof g.Event !== "function") {
    g.Event = class Event {
      constructor(type, init) {
        this.type = type;
        this.bubbles = !!(init && init.bubbles);
        this.cancelable = !!(init && init.cancelable);
        this.defaultPrevented = false;
      }
      preventDefault() { this.defaultPrevented = true; }
      stopPropagation() {}
    };
  }
  if (typeof g.EventTarget !== "function") {
    g.EventTarget = class EventTarget {
      constructor() { this._listeners = new Map(); }
      addEventListener(type, listener) {
        if (!this._listeners.has(type)) this._listeners.set(type, new Set());
        this._listeners.get(type).add(listener);
      }
      removeEventListener(type, listener) {
        if (this._listeners.has(type)) this._listeners.get(type).delete(listener);
      }
      dispatchEvent(event) {
        const ls = this._listeners.get(event.type);
        if (ls) for (const l of ls) l.call(this, event);
        return true;
      }
    };
  }

  // --- URL / URLSearchParams (minimal) ------------------------------------
  if (typeof g.URL !== "function") {
    g.URL = class URL {
      constructor(url, base) {
        const s = String(url);
        if (s.startsWith("data:")) {
          this.href = s; this.protocol = "data:"; this.pathname = s.slice(5);
          this.search = ""; this.hash = ""; this.origin = "null";
          return;
        }
        const m = s.match(
          /^([a-z][a-z0-9+\-.]*:)(?:\/\/([^\/?#]*))?([^?#]*)(\?[^#]*)?(#.*)?$/i
        );
        if (m) {
          this.protocol = m[1]; this.host = m[2] || ""; this.hostname = this.host;
          this.pathname = m[3] || "/"; this.search = m[4] || "";
          this.hash = m[5] || "";
          this.origin = this.host ? (this.protocol + "//" + this.host) : "null";
          this.href = s;
        } else if (base) {
          const b = new URL(base);
          this.href = b.origin + "/" + s.replace(/^\/+/, "");
          this.protocol = b.protocol; this.host = b.host; this.hostname = b.hostname;
          this.pathname = "/" + s.replace(/^\/+/, "");
          this.search = ""; this.hash = ""; this.origin = b.origin;
        } else {
          throw new TypeError("Invalid URL: " + s);
        }
      }
      toString() { return this.href; }
    };
    g.URL.createObjectURL = () => "blob:mock";
    g.URL.revokeObjectURL = () => {};
  }
  if (typeof g.URLSearchParams !== "function") {
    g.URLSearchParams = class URLSearchParams {
      constructor(init) {
        this._entries = [];
        if (typeof init === "string") {
          init.replace(/^\?/, "").split("&").forEach((p) => {
            if (!p) return;
            const [k, v = ""] = p.split("=");
            this._entries.push([decodeURIComponent(k), decodeURIComponent(v)]);
          });
        }
      }
      get(k) {
        const e = this._entries.find((e) => e[0] === k);
        return e ? e[1] : null;
      }
      set(k, v) {
        this._entries = this._entries.filter((e) => e[0] !== k);
        this._entries.push([k, String(v)]);
      }
      toString() {
        return this._entries
          .map((e) => encodeURIComponent(e[0]) + "=" + encodeURIComponent(e[1]))
          .join("&");
      }
    };
  }

  // --- TextEncoder / TextDecoder (UTF-8 only) -----------------------------
  if (typeof g.TextEncoder !== "function") {
    g.TextEncoder = class TextEncoder {
      get encoding() { return "utf-8"; }
      encode(str) {
        const s = String(str);
        const bytes = [];
        for (let i = 0; i < s.length; i++) {
          let c = s.charCodeAt(i);
          if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
            const c2 = s.charCodeAt(i + 1);
            if (c2 >= 0xdc00 && c2 <= 0xdfff) {
              c = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00); i++;
            }
          }
          if (c < 0x80) bytes.push(c);
          else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
          else if (c < 0x10000)
            bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
          else
            bytes.push(
              0xf0 | (c >> 18),
              0x80 | ((c >> 12) & 0x3f),
              0x80 | ((c >> 6) & 0x3f),
              0x80 | (c & 0x3f)
            );
        }
        return new Uint8Array(bytes);
      }
    };
  }
  if (typeof g.TextDecoder !== "function") {
    g.TextDecoder = class TextDecoder {
      constructor(label) {
        // Relaxed from the spike: some transitive deps construct
        // `new TextDecoder("ascii")` / `"latin1"` etc. We accept any label,
        // decode as UTF-8 — good enough for the paths our fixtures hit.
        this.encoding = (label || "utf-8").toLowerCase();
      }
      decode(bytes) {
        const a = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes.buffer || bytes);
        let out = ""; let i = 0;
        while (i < a.length) {
          const b1 = a[i++];
          if (b1 < 0x80) out += String.fromCharCode(b1);
          else if (b1 < 0xc0) out += "�";
          else if (b1 < 0xe0) {
            const b2 = a[i++] & 0x3f;
            out += String.fromCharCode(((b1 & 0x1f) << 6) | b2);
          } else if (b1 < 0xf0) {
            const b2 = a[i++] & 0x3f; const b3 = a[i++] & 0x3f;
            out += String.fromCharCode(((b1 & 0x0f) << 12) | (b2 << 6) | b3);
          } else {
            const b2 = a[i++] & 0x3f; const b3 = a[i++] & 0x3f; const b4 = a[i++] & 0x3f;
            const cp = ((b1 & 0x07) << 18) | (b2 << 12) | (b3 << 6) | b4;
            const c = cp - 0x10000;
            out += String.fromCharCode(0xd800 | (c >> 10), 0xdc00 | (c & 0x3ff));
          }
        }
        return out;
      }
    };
  }

  // --- performance (minimal) ----------------------------------------------
  if (typeof g.performance !== "object") {
    const t0 = Date.now();
    g.performance = { now() { return Date.now() - t0; }, timeOrigin: t0 };
  }

  // --- setTimeout / clearTimeout / setInterval (minimal) ------------------
  if (typeof g.setTimeout !== "function") {
    g.setTimeout = function (fn) { queueMicrotask(fn); return 0; };
    g.clearTimeout = function () {};
    g.setInterval = function () { return 0; };
    g.clearInterval = function () {};
  }

  // --- Worker / MessageChannel --------------------------------------------
  g.Worker = undefined;
  g.MessageChannel = undefined;

  // --- crypto.getRandomValues (deterministic) -----------------------------
  // R-007 discovery: the frames.excalidraw fixture reaches a nanoid-style
  // ID generator (`Ba=(A=21)=>crypto.getRandomValues(new Uint8Array(A))…`)
  // inside Excalidraw's export path. Deno provides `crypto` natively;
  // `deno_core`'s default runtime does NOT, so Rust throws `ReferenceError:
  // crypto is not defined` while Deno happily renders.
  //
  // Importantly, the generated IDs do NOT end up in the emitted SVG for
  // any of our fixtures (verified empirically — Deno's real-random crypto
  // still produced byte-identical output across runs). So the polyfill
  // only needs to satisfy the call signature, not produce realistic
  // entropy. We seed with a fixed constant so that IF a future fixture
  // DOES put these bytes into the SVG, the parity gate gates on a
  // deterministic value rather than noise.
  //
  // Host parity note: Deno still uses REAL crypto bytes and yields
  // different `Ba()` returns than this polyfill does. That's safe today
  // because no fixture emits those bytes. If R-007 ever flags a fixture
  // where randomness leaks into the output, the fix is to polyfill this
  // on the Deno side as well (pre-importing a shim in deno-run.mjs), not
  // to widen tolerances.
  if (typeof g.crypto !== "object" || typeof g.crypto.getRandomValues !== "function") {
    let __prng_state = 0x12345678 >>> 0;
    const __prng = () => {
      // xorshift32 — tiny, deterministic, good-enough distribution. We
      // discard the upper bits to fit in a byte.
      __prng_state ^= __prng_state << 13; __prng_state >>>= 0;
      __prng_state ^= __prng_state >>> 17; __prng_state >>>= 0;
      __prng_state ^= __prng_state << 5;  __prng_state >>>= 0;
      return __prng_state & 0xff;
    };
    const cryptoShim = {
      getRandomValues(arr) {
        const a = arr instanceof Uint8Array
          ? arr
          : new Uint8Array(arr.buffer || arr);
        for (let i = 0; i < a.length; i++) a[i] = __prng();
        return arr;
      },
      randomUUID() {
        // RFC 4122 v4-ish; bytes are deterministic but formatted correctly.
        const b = new Uint8Array(16);
        this.getRandomValues(b);
        b[6] = (b[6] & 0x0f) | 0x40;
        b[8] = (b[8] & 0x3f) | 0x80;
        const h = (n) => n.toString(16).padStart(2, "0");
        return (
          h(b[0]) + h(b[1]) + h(b[2]) + h(b[3]) + "-" +
          h(b[4]) + h(b[5]) + "-" +
          h(b[6]) + h(b[7]) + "-" +
          h(b[8]) + h(b[9]) + "-" +
          h(b[10]) + h(b[11]) + h(b[12]) + h(b[13]) + h(b[14]) + h(b[15])
        );
      },
    };
    g.crypto = cryptoShim;
  }
})();
"#;

/// Strip the last-remaining `import.meta.*` references from the bundle
/// before classic-script eval.
///
/// J-010's esbuild `define` replaces `import.meta.url`, `import.meta.env.DEV`,
/// `import.meta.env.PROD`, etc. with literals — but a small number of
/// **bare** `import.meta.env` accesses (e.g. `import.meta.env.MODE` at
/// runtime, dead-code in a jotai dev warning) survive the transform because
/// esbuild's `define` keys must be exact property paths. Classic-script
/// eval rejects any `import.meta` token with `SyntaxError: Cannot use
/// 'import.meta' outside a module`. Spike did the same string rewrite; see
/// `spike-rust/src/main.rs` and the feasibility spike notes.
///
/// This is a **workaround**, not the long-term fix. A follow-up J-010 task
/// should move this substitution into the esbuild step via a plugin so the
/// bundle is evaluable as a classic script on its own. Until then, this
/// 2-line rewrite keeps the Rust shell functional.
fn prepare_core(src: &str) -> String {
    src.replace(
        "import.meta.env",
        "({MODE:\"production\",DEV:false,PROD:true})",
    )
    .replace("import.meta.url", "\"file:///core.mjs\"")
}

// Build-time WOFF2 blob + index for the JS engine path (Excalidraw's subsetter
// expects WOFF2). Generated by build.rs from brotli-compressed TTF sub-crates.
include!(concat!(env!("OUT_DIR"), "/embedded_fonts_js.rs"));

/// Populate `globalThis.__embeddedFonts` from the build-time WOFF2 blob.
///
/// `fetch-fonts.mjs` and `text-metrics.mjs` look up byte payloads from this
/// global at render time. Excalidraw's bundled subsetter expects WOFF2 bytes
/// (it calls woff2Dec internally), so build.rs pre-encodes the brotli-compressed
/// TTF from font sub-crates into WOFF2 via the pure-Rust ttf2woff2 crate.
/// The shape mirrors what Deno's `dev.mjs` populates from disk so
/// the parity gate stays meaningful.
fn install_embedded_fonts(rt: &mut JsRuntime) {
    deno_core::scope!(scope, rt);
    let context = scope.get_current_context();
    let global = context.global(scope);

    let obj = v8::Object::new(scope);
    for &(path, start, len) in EMBEDDED_FONTS_JS_INDEX {
        let woff2_bytes = &EMBEDDED_FONTS_JS_BLOB[start..start + len];
        let backing = v8::ArrayBuffer::new_backing_store_from_vec(woff2_bytes.to_vec());
        let buf = v8::ArrayBuffer::with_backing_store(scope, &backing.make_shared());
        let arr = v8::Uint8Array::new(scope, buf, 0, len).expect("Uint8Array::new returned None");
        let key =
            v8::String::new(scope, path).expect("v8::String::new returned None for font path");
        obj.set(scope, key.into(), arr.into());
    }
    let key = v8::String::new(scope, "__embeddedFonts")
        .expect("v8::String::new returned None for __embeddedFonts");
    global.set(scope, key.into(), obj.into());
}

pub struct Engine {
    rt: JsRuntime,
}

impl Engine {
    /// Create a fresh engine and load the bundled JS core. Panics (via
    /// `expect`) if the core fails to evaluate — there is no meaningful
    /// recovery from a busted bundle, and the caller gets a clear message
    /// pointing at the underlying JsError.
    pub fn new() -> Self {
        let mut rt = JsRuntime::new(RuntimeOptions::default());
        rt.execute_script("bootstrap.js", PRE_CORE_BOOTSTRAP)
            .expect("pre-core bootstrap failed to evaluate");
        install_embedded_fonts(&mut rt);
        let core = prepare_core(CORE_MJS);
        rt.execute_script("core.mjs", core)
            .expect("core.mjs failed to load — did `make core` run cleanly?");
        Self { rt }
    }

    /// Create an engine by deserializing a pre-built V8 startup snapshot
    /// produced by [`create_snapshot`]. Skips the bootstrap eval and the
    /// core.mjs eval (already baked into the snapshot heap) — only the
    /// runtime-only `__embeddedFonts` global is installed here, since
    /// font bytes are deliberately NOT in the snapshot (they're read
    /// only at render time).
    ///
    /// Internal: callers go through [`new_cached`](Self::new_cached);
    /// the V8 startup-mode constraint means this must not be combined
    /// with [`create_snapshot`] in the same process.
    fn from_snapshot(snapshot: &'static [u8]) -> Self {
        let mut rt = JsRuntime::new(RuntimeOptions {
            startup_snapshot: Some(snapshot),
            ..Default::default()
        });
        install_embedded_fonts(&mut rt);
        Self { rt }
    }

    /// Best-effort fast path for cold engine init.
    ///
    /// On first run on a given machine: returns [`Engine::new`] (cold
    /// bootstrap + core.mjs eval, ~80 ms on a modern Mac) and spawns
    /// the current binary in the background to bake a startup snapshot
    /// into the user's cache dir (see [`snapshot_cache::cache_path`]).
    /// Subsequent runs find that file and use [`Engine::from_snapshot`]
    /// instead, dropping init to ~6 ms.
    ///
    /// The cache file is keyed on a CRC32 of the embedded `core.mjs`
    /// plus the crate version, so upgrading the binary invalidates
    /// stale snapshots automatically. The background warmer also
    /// prunes any other `core-*.snap` files in the cache dir so old
    /// versions don't accumulate.
    ///
    /// Disable with `EXCALIDRAW_IMAGE_NO_SNAPSHOT_CACHE=1`. Override
    /// the cache directory with `EXCALIDRAW_IMAGE_CACHE_DIR=<path>`.
    pub fn new_cached() -> Self {
        if snapshot_cache::is_disabled() {
            return Self::new();
        }

        if let Some(bytes) = snapshot_cache::load() {
            // SAFETY: `RuntimeOptions::startup_snapshot` requires `'static`.
            // We deliberately leak — there's exactly one snapshot per process
            // and the bytes are reclaimed at process exit.
            let leaked: &'static [u8] = Box::leak(bytes.into_boxed_slice());
            return Self::from_snapshot(leaked);
        }

        snapshot_cache::warm_in_background();
        Self::new()
    }

    /// Render a scene to SVG.
    ///
    /// * `scene` — the full `.excalidraw` JSON as a string. Passed to the
    ///   JS side as a string; `__render` handles `typeof === "string"`
    ///   normalization.
    /// * `opts_json` — a JSON string produced by `argv::Args::opts_json()`.
    ///   Must be a valid JSON object literal (e.g. `{"background":true}`);
    ///   `render()` parses it inside the trampoline.
    pub async fn render(&mut self, scene: &str, opts_json: &str) -> anyhow::Result<RenderResult> {
        // Stash inputs as globals. Scene is JSON-encoded to survive embedding
        // in a JS string literal; opts_json is already valid JSON so we
        // inject it directly as an object literal.
        let setup = format!(
            "globalThis.__input = {}; globalThis.__opts = {};",
            serde_json::to_string(scene)?,
            opts_json,
        );
        self.rt.execute_script("setup.js", setup)?;

        let promise = self.rt.execute_script(
            "call.js",
            "globalThis.__render(globalThis.__input, globalThis.__opts)",
        )?;

        // resolve() → future that awaits the promise; with_event_loop_promise
        // pumps the event loop concurrently. Box::pin to satisfy the `Unpin`
        // bound in 0.399.0.
        let resolve = self.rt.resolve(promise);
        let resolved = self
            .rt
            .with_event_loop_promise(Box::pin(resolve), PollEventLoopOptions::default())
            .await?;

        // v8::Global<Value> → RenderResult via serde_v8.
        let result: RenderResult = {
            deno_core::scope!(scope, &mut self.rt);
            let local = v8::Local::new(scope, resolved);
            serde_v8::from_v8(scope, local)?
        };
        Ok(result)
    }
}

impl Default for Engine {
    fn default() -> Self {
        Self::new()
    }
}

/// Build a V8 startup snapshot containing `PRE_CORE_BOOTSTRAP` and the
/// evaluated JS core. Called only from the snapshot-builder child
/// process (see [`snapshot_cache::warm_in_background`]); the V8
/// startup-mode constraint means the same process must not have
/// previously created a non-snapshotting `JsRuntime`.
///
/// Fonts are intentionally NOT installed before snapshotting — they're
/// only read at render time, and embedding their ~10–20 MB of WOFF2
/// bytes would defeat the purpose. `Engine::from_snapshot` installs
/// them post-deserialization.
fn create_snapshot() -> Box<[u8]> {
    let mut rt = JsRuntimeForSnapshot::new(RuntimeOptions::default());
    rt.execute_script("bootstrap.js", PRE_CORE_BOOTSTRAP)
        .expect("pre-core bootstrap failed to evaluate (snapshotting)");
    let core = prepare_core(CORE_MJS);
    rt.execute_script("core.mjs", core)
        .expect("core.mjs failed to load (snapshotting) — did `make core` run cleanly?");
    rt.snapshot()
}

/// Runtime snapshot cache. The shipping binary stays small (no
/// embedded snapshot blob — see commit history for the rejected
/// approach), and instead each user's machine warms a per-target
/// snapshot on first run.
///
/// Cache key: CRC32 of the embedded `core.mjs` (computed at build
/// time, exposed via `EXCALIDRAW_IMAGE_CORE_CRC32`) + crate version.
/// Upgrading the binary picks up a new key automatically; the
/// background warmer prunes stale `core-*.snap` files when it writes.
pub mod snapshot_cache {
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::process::Command;

    /// crc32 of the embedded core.mjs, set by build.rs.
    const CORE_CRC32: &str = env!("EXCALIDRAW_IMAGE_CORE_CRC32");
    /// Crate version — folds into the cache filename so upgrades invalidate.
    const VERSION: &str = env!("CARGO_PKG_VERSION");

    /// Sentinel env var. When set on a child process, it skips all the
    /// normal CLI plumbing and just builds a snapshot to the path given
    /// by the var's value, then exits. Read by `main.rs` BEFORE any
    /// non-snapshotting V8 init happens.
    pub const BUILD_SENTINEL_ENV: &str = "__EXCALIDRAW_IMAGE_BUILD_SNAPSHOT";

    /// Disable the runtime cache entirely.
    pub const DISABLE_ENV: &str = "EXCALIDRAW_IMAGE_NO_SNAPSHOT_CACHE";

    /// Override the cache root.
    pub const CACHE_DIR_ENV: &str = "EXCALIDRAW_IMAGE_CACHE_DIR";

    pub fn is_disabled() -> bool {
        std::env::var_os(DISABLE_ENV)
            .map(|v| !v.is_empty() && v != *"0")
            .unwrap_or(false)
    }

    /// Resolve the cache directory.
    ///
    /// Priority:
    /// 1. `$EXCALIDRAW_IMAGE_CACHE_DIR`
    /// 2. macOS:   `$HOME/Library/Caches/excalidraw-image`
    /// 3. Windows: `%LOCALAPPDATA%\excalidraw-image\cache`
    /// 4. *nix:    `$XDG_CACHE_HOME/excalidraw-image` or
    ///    `$HOME/.cache/excalidraw-image`
    fn cache_dir() -> Option<PathBuf> {
        if let Some(d) = std::env::var_os(CACHE_DIR_ENV).filter(|v| !v.is_empty()) {
            return Some(PathBuf::from(d));
        }
        #[cfg(target_os = "macos")]
        {
            let home = std::env::var_os("HOME")?;
            Some(PathBuf::from(home).join("Library/Caches/excalidraw-image"))
        }
        #[cfg(target_os = "windows")]
        {
            let local = std::env::var_os("LOCALAPPDATA")?;
            Some(PathBuf::from(local).join("excalidraw-image").join("cache"))
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            if let Some(x) = std::env::var_os("XDG_CACHE_HOME").filter(|v| !v.is_empty()) {
                return Some(PathBuf::from(x).join("excalidraw-image"));
            }
            let home = std::env::var_os("HOME")?;
            Some(PathBuf::from(home).join(".cache").join("excalidraw-image"))
        }
    }

    /// Filename of the snapshot for the *current* binary.
    fn cache_filename() -> String {
        format!("core-{VERSION}-{CORE_CRC32}.snap")
    }

    /// Full path to the current snapshot.
    pub fn cache_path() -> Option<PathBuf> {
        Some(cache_dir()?.join(cache_filename()))
    }

    /// Read the cached snapshot if it exists. Failures are silent —
    /// the caller falls back to the cold path.
    pub fn load() -> Option<Vec<u8>> {
        let p = cache_path()?;
        match fs::read(&p) {
            Ok(b) if !b.is_empty() => Some(b),
            _ => None,
        }
    }

    /// Spawn a detached child process that builds the snapshot and
    /// writes it to the cache. Best-effort — if anything fails the
    /// next invocation just retries.
    pub fn warm_in_background() {
        let Some(dest) = cache_path() else { return };

        let exe = match std::env::current_exe() {
            Ok(p) => p,
            Err(_) => return,
        };

        // Create the cache dir up-front so the child's atomic-rename
        // target exists. If we can't create it, abort warming.
        if let Some(parent) = dest.parent() {
            if fs::create_dir_all(parent).is_err() {
                return;
            }
        }

        let mut cmd = Command::new(exe);
        cmd.env(BUILD_SENTINEL_ENV, &dest);
        // Detach: don't inherit stdio (writing to closed pipes if the
        // parent exits would otherwise kill the warmer).
        cmd.stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());

        // Best-effort spawn; ignore the child handle so we don't wait.
        let _ = cmd.spawn();
    }

    /// Build a snapshot in the current process and write it to
    /// `dest`. Atomic via temp-file + rename. Also prunes any other
    /// `core-*.snap` files in the same directory.
    ///
    /// Called from main.rs when `BUILD_SENTINEL_ENV` is set. MUST be
    /// invoked before any other V8 init in this process — the sentinel
    /// path keeps that contract.
    pub fn build_and_write(dest: &Path) -> std::io::Result<()> {
        let snapshot = super::create_snapshot();

        let parent = dest
            .parent()
            .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "no parent"))?;
        fs::create_dir_all(parent)?;

        let tmp = parent.join(format!(
            "{}.tmp.{}",
            dest.file_name()
                .map(|f| f.to_string_lossy().into_owned())
                .unwrap_or_else(|| "core.snap".to_string()),
            std::process::id(),
        ));
        fs::write(&tmp, &snapshot)?;
        // Atomic on POSIX; on Windows, fs::rename replaces an existing
        // destination since Rust 1.5+ via MoveFileExW(REPLACE_EXISTING).
        fs::rename(&tmp, dest)?;

        prune_stale(parent, dest);
        Ok(())
    }

    /// Remove any `core-*.snap` files in `dir` that don't equal
    /// `keep`. Keeps the cache from growing unbounded across upgrades.
    fn prune_stale(dir: &Path, keep: &Path) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        let keep_name = keep.file_name();
        for entry in entries.flatten() {
            let path = entry.path();
            if Some(path.file_name().unwrap_or_default()) == keep_name {
                continue;
            }
            let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
                continue;
            };
            // Match our own naming scheme only; never touch unrelated files.
            // Accept both the current snapshot prefix and any leftover
            // .tmp.<pid> files from a prior interrupted write.
            let is_ours = name.starts_with("core-")
                && (name.ends_with(".snap")
                    || (name.contains(".snap.tmp.") && !name.ends_with(".tmp.")));
            if !is_ours {
                continue;
            }
            let _ = fs::remove_file(&path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Minimal inline scene — one rectangle. Exercises the full bundle
    // evaluation + __render call path without depending on the fixture
    // files or the shim install order (which other tests cover).
    //
    // If this test ever starts failing with a bundle-load error, the
    // diagnosis order is:
    //   1. dist/core.mjs current? (make core)
    //   2. shim install order correct? (see the feasibility spike notes Finding B+C)
    //   3. deno_core version still 0.399.0?
    const MINIMAL_SCENE: &str = r##"{
        "type": "excalidraw",
        "version": 2,
        "source": "test",
        "elements": [
            {
                "id": "r1",
                "type": "rectangle",
                "x": 0,
                "y": 0,
                "width": 100,
                "height": 50,
                "angle": 0,
                "strokeColor": "#000000",
                "backgroundColor": "transparent",
                "fillStyle": "solid",
                "strokeWidth": 1,
                "strokeStyle": "solid",
                "roughness": 1,
                "opacity": 100,
                "groupIds": [],
                "frameId": null,
                "roundness": null,
                "seed": 1,
                "version": 1,
                "versionNonce": 1,
                "isDeleted": false,
                "boundElements": null,
                "updated": 0,
                "link": null,
                "locked": false
            }
        ],
        "appState": { "viewBackgroundColor": "#ffffff" },
        "files": {}
    }"##;

    #[tokio::test]
    async fn render_produces_svg() {
        let mut engine = Engine::new();
        let result = engine
            .render(MINIMAL_SCENE, "{}")
            .await
            .expect("render must succeed on a minimal scene");
        assert!(
            result.svg.starts_with("<svg"),
            "expected SVG output, got: {}",
            &result.svg.chars().take(80).collect::<String>()
        );
    }
}
