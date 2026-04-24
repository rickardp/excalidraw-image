// Spike-only polyfills for globals that Deno ships but deno_core does not.
// See main.rs for rationale. R-001 should move these into the JS bundle
// (src/core/shims/install.mjs) or adopt the deno_web/deno_url extensions.
(function () {
  const g = globalThis;

  // --- atob / btoa ---------------------------------------------------------
  if (typeof g.atob !== "function") {
    const B64 =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    g.atob = function (input) {
      const s = String(input).replace(/=+$/, "");
      let out = "";
      let buf = 0,
        bits = 0;
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
        const t3 =
          b === -1 ? 64 : ((b & 15) << 2) | (c === -1 ? 0 : c >> 6);
        const t4 = c === -1 ? 64 : c & 63;
        out +=
          B64[t1] +
          B64[t2] +
          (t3 === 64 ? "=" : B64[t3]) +
          (t4 === 64 ? "=" : B64[t4]);
      }
      return out;
    };
  }

  // --- DOMException -------------------------------------------------------
  if (typeof g.DOMException !== "function") {
    g.DOMException = class DOMException extends Error {
      constructor(message, name) {
        super(message);
        this.name = name || "Error";
      }
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
      preventDefault() {
        this.defaultPrevented = true;
      }
      stopPropagation() {}
    };
  }
  if (typeof g.EventTarget !== "function") {
    g.EventTarget = class EventTarget {
      constructor() {
        this._listeners = new Map();
      }
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
  // Good enough for the basic-shapes path — the bundle uses URL mostly to
  // parse data: URLs and construct file:// URLs. Not a WHATWG-compliant URL.
  if (typeof g.URL !== "function") {
    g.URL = class URL {
      constructor(url, base) {
        const s = String(url);
        // data: URLs — keep the whole thing; consumers usually read `href`.
        if (s.startsWith("data:")) {
          this.href = s;
          this.protocol = "data:";
          this.pathname = s.slice(5);
          this.search = "";
          this.hash = "";
          this.origin = "null";
          return;
        }
        const m = s.match(
          /^([a-z][a-z0-9+\-.]*:)(?:\/\/([^\/?#]*))?([^?#]*)(\?[^#]*)?(#.*)?$/i,
        );
        if (m) {
          this.protocol = m[1];
          this.host = m[2] || "";
          this.hostname = this.host;
          this.pathname = m[3] || "/";
          this.search = m[4] || "";
          this.hash = m[5] || "";
          this.origin = this.host ? `${this.protocol}//${this.host}` : "null";
          this.href = s;
        } else if (base) {
          // relative resolution (minimal — good enough for our use)
          const b = new URL(base);
          this.href = b.origin + "/" + s.replace(/^\/+/, "");
          this.protocol = b.protocol;
          this.host = b.host;
          this.hostname = b.hostname;
          this.pathname = "/" + s.replace(/^\/+/, "");
          this.search = "";
          this.hash = "";
          this.origin = b.origin;
        } else {
          throw new TypeError(`Invalid URL: ${s}`);
        }
      }
      toString() {
        return this.href;
      }
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
      get encoding() {
        return "utf-8";
      }
      encode(str) {
        const s = String(str);
        const bytes = [];
        for (let i = 0; i < s.length; i++) {
          let c = s.charCodeAt(i);
          // surrogate pair
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
            bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
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
  if (typeof g.TextDecoder !== "function") {
    g.TextDecoder = class TextDecoder {
      constructor(label) {
        this.encoding = (label || "utf-8").toLowerCase();
        if (this.encoding !== "utf-8" && this.encoding !== "utf8") {
          throw new Error("TextDecoder polyfill: only utf-8 supported");
        }
      }
      decode(bytes) {
        const a = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes.buffer || bytes);
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
    let t0 = Date.now();
    g.performance = {
      now() {
        return Date.now() - t0;
      },
      timeOrigin: t0,
    };
  }

  // --- setTimeout / clearTimeout / setInterval (minimal) ------------------
  // The bundle schedules a handful of timers indirectly (Promise.resolve()
  // ticks, pako compression progress). For basic-shapes, we only need them
  // to exist — they're not functionally used.
  if (typeof g.setTimeout !== "function") {
    g.setTimeout = function (fn) {
      queueMicrotask(fn);
      return 0;
    };
    g.clearTimeout = function () {};
    g.setInterval = function () {
      return 0;
    };
    g.clearInterval = function () {};
  }

  // --- Worker / MessageChannel -------------------------------------------
  // Explicitly undefined. Excalidraw's font subset module captures `typeof
  // Worker` at module eval time; undefined → synchronous subset, no workers.
  g.Worker = undefined;
  g.MessageChannel = undefined;
})();
