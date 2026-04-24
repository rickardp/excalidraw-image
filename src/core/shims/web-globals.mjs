// src/core/shims/web-globals.mjs
//
// Installs the Web-platform globals that Deno provides but `deno_core` does
// not. See PHASE0.md §"Finding B" and PLAN.md §4.2. Source of truth polyfills
// from spike-rust/src/polyfills.js (F-002).
//
// Strategy per global: if already present (native V8 / host / Deno), leave
// alone. Polyfill only when absent. Idempotent — subsequent calls no-op.
//
// Note: once P-002's eslint config is extended (per F-002 notes) to also
// forbid direct reads of `atob`/`btoa`/`DOMException`/`URL`/... outside
// `src/core/shims/**`, re-add:
//   /* eslint-disable no-restricted-globals */
// at the top of this file — this shim is the single authorized definition
// site. For now the rule only covers host-runtime globals so no disable is
// required.

let installed = false;

export function installWebGlobalsShim() {
  if (installed) return;
  installed = true;

  const g = globalThis;
  const w = typeof g.window === "object" && g.window !== null ? g.window : null;

  const assign = (name, value) => {
    if (g[name] === undefined) {
      Object.defineProperty(g, name, {
        value,
        writable: true,
        configurable: true,
        enumerable: false,
      });
    }
    // Mirror onto window when it exists (installed by dom.mjs).
    if (w && w[name] === undefined) {
      try {
        w[name] = g[name];
      } catch {
        // linkedom's window may freeze some props; ignore.
      }
    }
  };

  // --- btoa / atob --------------------------------------------------------
  if (g.btoa === undefined || g.atob === undefined) {
    const B64 =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    if (g.atob === undefined) {
      assign("atob", function atob(input) {
        const s = String(input).replace(/=+$/, "");
        let out = "";
        let buf = 0;
        let bits = 0;
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
      });
    }
    if (g.btoa === undefined) {
      assign("btoa", function btoa(input) {
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
          out +=
            B64[t1] +
            B64[t2] +
            (t3 === 64 ? "=" : B64[t3]) +
            (t4 === 64 ? "=" : B64[t4]);
        }
        return out;
      });
    }
  } else {
    // Already present on globalThis; still mirror to window.
    assign("btoa", g.btoa);
    assign("atob", g.atob);
  }

  // --- URL / URLSearchParams ---------------------------------------------
  // Prefer the native V8/host implementations. V8 ships WHATWG URL in modern
  // builds — both Deno and deno_core generally expose it. Polyfill only if
  // the host truly omits them.
  if (g.URL === undefined) {
    assign("URL", makeMinimalURL());
  } else {
    assign("URL", g.URL);
  }
  if (g.URLSearchParams === undefined) {
    assign("URLSearchParams", makeMinimalURLSearchParams());
  } else {
    assign("URLSearchParams", g.URLSearchParams);
  }

  // --- TextEncoder / TextDecoder -----------------------------------------
  // Likewise prefer native; V8 provides these in every modern runtime.
  if (g.TextEncoder === undefined) {
    assign("TextEncoder", makeMinimalTextEncoder());
  } else {
    assign("TextEncoder", g.TextEncoder);
  }
  if (g.TextDecoder === undefined) {
    assign("TextDecoder", makeMinimalTextDecoder());
  } else {
    assign("TextDecoder", g.TextDecoder);
  }

  // --- Event / EventTarget (minimal) -------------------------------------
  if (g.Event === undefined) {
    assign(
      "Event",
      class Event {
        constructor(type, init) {
          this.type = String(type);
          this.bubbles = !!(init && init.bubbles);
          this.cancelable = !!(init && init.cancelable);
          this.defaultPrevented = false;
        }
        preventDefault() {
          this.defaultPrevented = true;
        }
        stopPropagation() {}
        stopImmediatePropagation() {}
      },
    );
  } else {
    assign("Event", g.Event);
  }
  if (g.EventTarget === undefined) {
    assign(
      "EventTarget",
      class EventTarget {
        constructor() {
          this._listeners = new Map();
        }
        addEventListener(type, listener) {
          if (typeof listener !== "function") return;
          if (!this._listeners.has(type)) this._listeners.set(type, new Set());
          this._listeners.get(type).add(listener);
        }
        removeEventListener(type, listener) {
          if (this._listeners.has(type)) {
            this._listeners.get(type).delete(listener);
          }
        }
        dispatchEvent(event) {
          const ls = this._listeners.get(event && event.type);
          if (ls) for (const l of ls) l.call(this, event);
          return true;
        }
      },
    );
  } else {
    assign("EventTarget", g.EventTarget);
  }

  // --- DOMException -------------------------------------------------------
  if (g.DOMException === undefined) {
    assign(
      "DOMException",
      class DOMException extends Error {
        constructor(message, name) {
          super(message);
          this.name = name || "Error";
        }
      },
    );
  } else {
    assign("DOMException", g.DOMException);
  }

  // --- performance --------------------------------------------------------
  if (g.performance === undefined || typeof g.performance.now !== "function") {
    const t0 = Date.now();
    assign("performance", {
      now() {
        return Date.now() - t0;
      },
      timeOrigin: t0,
    });
  } else {
    assign("performance", g.performance);
  }

  // --- setTimeout / clearTimeout / setInterval / clearInterval -----------
  // Use the host-provided versions when present (deno_core's timer ops do
  // work). Polyfill individually only when missing.
  if (g.setTimeout === undefined) {
    assign("setTimeout", (fn, _ms) => {
      queueMicrotask(() => {
        try {
          fn();
        } catch {
          // swallow — deno_core's timer semantics don't bubble either.
        }
      });
      return 0;
    });
  } else {
    assign("setTimeout", g.setTimeout);
  }
  if (g.clearTimeout === undefined) {
    assign("clearTimeout", () => {});
  } else {
    assign("clearTimeout", g.clearTimeout);
  }
  if (g.setInterval === undefined) {
    assign("setInterval", () => 0);
  } else {
    assign("setInterval", g.setInterval);
  }
  if (g.clearInterval === undefined) {
    assign("clearInterval", () => {});
  } else {
    assign("clearInterval", g.clearInterval);
  }
}

// --- Polyfill factories (kept out of the install path so they only cost
// --- bundle bytes when actually referenced). -----------------------------

function makeMinimalURL() {
  // Minimal path-only URL parser. Only used when the host truly lacks URL;
  // V8 ships WHATWG URL everywhere we target so this is a deep fallback.
  class URL {
    constructor(url) {
      const s = String(url);
      const m = s.match(
        /^([a-z][a-z0-9+\-.]*:)(?:\/\/([^/?#]*))?([^?#]*)(\?[^#]*)?(#.*)?$/i,
      );
      if (!m) throw new TypeError(`Invalid URL: ${s}`);
      this.protocol = m[1];
      this.host = m[2] || "";
      this.hostname = this.host;
      this.pathname = m[3] || "/";
      this.search = m[4] || "";
      this.hash = m[5] || "";
      this.origin = this.host ? `${this.protocol}//${this.host}` : "null";
      this.href = s;
      const SP = globalThis.URLSearchParams;
      this._sp = SP ? new SP(this.search.replace(/^\?/, "")) : null;
    }
    get searchParams() {
      return this._sp;
    }
    toString() {
      return this.href;
    }
  }
  return URL;
}

function makeMinimalURLSearchParams() {
  return class URLSearchParams {
    constructor(init) {
      this._e = [];
      if (typeof init === "string" && init) {
        for (const p of init.replace(/^\?/, "").split("&")) {
          if (!p) continue;
          const i = p.indexOf("=");
          const k = i < 0 ? p : p.slice(0, i);
          const v = i < 0 ? "" : p.slice(i + 1);
          this._e.push([decodeURIComponent(k), decodeURIComponent(v)]);
        }
      }
    }
    get(k) {
      const e = this._e.find((e) => e[0] === k);
      return e ? e[1] : null;
    }
    set(k, v) {
      this._e = this._e.filter((e) => e[0] !== k);
      this._e.push([k, String(v)]);
    }
    toString() {
      return this._e
        .map((e) => encodeURIComponent(e[0]) + "=" + encodeURIComponent(e[1]))
        .join("&");
    }
  };
}

function makeMinimalTextEncoder() {
  return class TextEncoder {
    get encoding() {
      return "utf-8";
    }
    encode(str) {
      const s = String(str);
      const bytes = [];
      for (let i = 0; i < s.length; i++) {
        let c = s.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
          const c2 = s.charCodeAt(i + 1);
          if (c2 >= 0xdc00 && c2 <= 0xdfff) {
            c = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
            i++;
          }
        }
        if (c < 0x80) {
          bytes.push(c);
        } else if (c < 0x800) {
          bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
        } else if (c < 0x10000) {
          bytes.push(
            0xe0 | (c >> 12),
            0x80 | ((c >> 6) & 0x3f),
            0x80 | (c & 0x3f),
          );
        } else {
          bytes.push(
            0xf0 | (c >> 18),
            0x80 | ((c >> 12) & 0x3f),
            0x80 | ((c >> 6) & 0x3f),
            0x80 | (c & 0x3f),
          );
        }
      }
      return new Uint8Array(bytes);
    }
  };
}

function makeMinimalTextDecoder() {
  return class TextDecoder {
    constructor(label) {
      this.encoding = (label || "utf-8").toLowerCase();
      if (this.encoding !== "utf-8" && this.encoding !== "utf8") {
        throw new Error("TextDecoder polyfill: only utf-8 supported");
      }
    }
    decode(bytes) {
      const a =
        bytes instanceof Uint8Array
          ? bytes
          : new Uint8Array(bytes.buffer || bytes);
      let out = "";
      let i = 0;
      while (i < a.length) {
        const b1 = a[i++];
        if (b1 < 0x80) {
          out += String.fromCharCode(b1);
        } else if (b1 < 0xc0) {
          out += "�";
        } else if (b1 < 0xe0) {
          const b2 = a[i++] & 0x3f;
          out += String.fromCharCode(((b1 & 0x1f) << 6) | b2);
        } else if (b1 < 0xf0) {
          const b2 = a[i++] & 0x3f;
          const b3 = a[i++] & 0x3f;
          out += String.fromCharCode(((b1 & 0x0f) << 12) | (b2 << 6) | b3);
        } else {
          const b2 = a[i++] & 0x3f;
          const b3 = a[i++] & 0x3f;
          const b4 = a[i++] & 0x3f;
          const cp =
            ((b1 & 0x07) << 18) | (b2 << 12) | (b3 << 6) | b4;
          const c = cp - 0x10000;
          out += String.fromCharCode(
            0xd800 | (c >> 10),
            0xdc00 | (c & 0x3ff),
          );
        }
      }
      return out;
    }
  };
}
