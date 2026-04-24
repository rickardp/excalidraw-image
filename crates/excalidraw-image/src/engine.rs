// R-003 — `deno_core` wrapper for `excalidraw-image`.
//
// Owns a single `JsRuntime` and exposes one async method: `render(scene,
// opts_json) -> { svg }`. The runtime loads the pre-bundled JS core
// (`dist/core.mjs`, copied into OUT_DIR by `build.rs`) once at `new()`; every
// subsequent render reuses the same V8 isolate.
//
// Design notes (from F-002 spike + PHASE0.md):
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

use deno_core::{serde_v8, v8, JsRuntime, PollEventLoopOptions, RuntimeOptions};
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
/// `spike-rust/src/main.rs` and PHASE0.md §"Finding D".
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
        let core = prepare_core(CORE_MJS);
        rt.execute_script("core.mjs", core)
            .expect("core.mjs failed to load — did `make core` run cleanly?");
        Self { rt }
    }

    /// Render a scene to SVG.
    ///
    /// * `scene` — the full `.excalidraw` JSON as a string. Passed to the
    ///   JS side as a string; `__render` handles `typeof === "string"`
    ///   normalization.
    /// * `opts_json` — a JSON string produced by `argv::Args::opts_json()`.
    ///   Must be a valid JSON object literal (e.g. `{"background":true}`);
    ///   `render()` parses it inside the trampoline.
    pub async fn render(
        &mut self,
        scene: &str,
        opts_json: &str,
    ) -> anyhow::Result<RenderResult> {
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
    //   2. shim install order correct? (see PHASE0.md Finding B+C)
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
