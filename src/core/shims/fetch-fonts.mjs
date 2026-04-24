// src/core/shims/fetch-fonts.mjs
//
// Installs a `globalThis.fetch` wrapper that:
//   1. Serves Excalidraw's bundled WOFF2 font assets from FONT_ASSETS,
//      returning a synthetic Response-like object. Excalidraw only calls
//      `.arrayBuffer()` on these; other members are stubbed.
//   2. Delegates `data:` URLs to the previous (host) fetch if present, or
//      parses them inline to a Response-like fallback.
//   3. Throws `Error("network fetch not allowed in CLI: <url>")` for any
//      other URL — see PLAN.md §4.2 and §4A.7.
//
// Host-neutral: no node:*, no fs, no Buffer. Uses `atob` from web-globals.
// Idempotent — calling install twice leaves a single wrapper in place.
//
// J-004 — replaces the F-001 spike fetch shim that 404'd all font URLs.

import { FONT_ASSETS } from "../font-assets.mjs";

// Marker we stamp on our wrapper so a second install call is a no-op.
const INSTALLED_MARKER = Symbol.for("excalidraw-image.fetch-fonts.installed");

// Built once, at module load. Maps font-asset path (e.g.
// "Excalifont/Excalifont-Regular-<hash>.woff2") to its base64 payload.
// Runtime path-index — PLAN §4A.7 says we do not pre-bake FONT_URL_MAP.
const PATH_INDEX = (() => {
  const m = new Map();
  for (const entries of Object.values(FONT_ASSETS)) {
    for (const entry of entries) {
      m.set(entry.path, entry.base64);
    }
  }
  return m;
})();

function findFontBase64ForUrl(url) {
  // Excalidraw requests fonts via
  //   <PKG_NAME>@<PKG_VERSION>/dist/prod/fonts/<Family>/<filename>.woff2
  // We match by suffix so any host/CDN prefix works.
  for (const [path, base64] of PATH_INDEX) {
    if (url.endsWith(path)) return base64;
  }
  return null;
}

function base64ToBytes(b64) {
  // Relies on `atob` installed by web-globals.mjs (J-002) or present
  // natively on V8 hosts. We read through globalThis to stay explicit.
  const bin = globalThis.atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function urlFromInput(input) {
  if (typeof input === "string") return input;
  if (input && typeof input.url === "string") return input.url;
  return String(input);
}

function synthesizeFontResponse(bytes, url) {
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  );
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    url,
    headers: {
      get(name) {
        return String(name).toLowerCase() === "content-type"
          ? "font/woff2"
          : null;
      },
    },
    async arrayBuffer() {
      return buf;
    },
    async blob() {
      if (typeof globalThis.Blob === "function") {
        return new globalThis.Blob([bytes], { type: "font/woff2" });
      }
      // Minimal stand-in: consumers that only need arrayBuffer/size/type work.
      return {
        size: bytes.byteLength,
        type: "font/woff2",
        arrayBuffer: async () => buf,
      };
    },
    async text() {
      throw new Error("font responses are binary");
    },
    async json() {
      throw new Error("font responses are binary");
    },
    clone() {
      return synthesizeFontResponse(bytes, url);
    },
  };
}

function parseDataUrlInline(url) {
  // Minimal data: URL parser — just enough for test #2 and for hosts that
  // lack a native fetch. Spec: data:[<mediatype>][;base64],<data>
  const comma = url.indexOf(",");
  if (comma < 0) throw new TypeError(`invalid data URL: ${url.slice(0, 40)}…`);
  const meta = url.slice(5, comma); // after "data:"
  const payload = url.slice(comma + 1);
  const isBase64 = /;base64$/i.test(meta);
  const mediaType = (isBase64 ? meta.replace(/;base64$/i, "") : meta) ||
    "text/plain;charset=US-ASCII";

  let bytes;
  if (isBase64) {
    bytes = base64ToBytes(payload);
  } else {
    const decoded = decodeURIComponent(payload);
    bytes = new Uint8Array(decoded.length);
    for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i) & 0xff;
  }
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  );
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    url,
    headers: {
      get(name) {
        return String(name).toLowerCase() === "content-type" ? mediaType : null;
      },
    },
    async arrayBuffer() {
      return buf;
    },
    async text() {
      // Decode payload as UTF-8 text.
      if (typeof globalThis.TextDecoder === "function") {
        return new globalThis.TextDecoder("utf-8").decode(bytes);
      }
      let s = "";
      for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
      return s;
    },
    async blob() {
      if (typeof globalThis.Blob === "function") {
        return new globalThis.Blob([bytes], { type: mediaType });
      }
      return {
        size: bytes.byteLength,
        type: mediaType,
        arrayBuffer: async () => buf,
      };
    },
    async json() {
      const t =
        typeof globalThis.TextDecoder === "function"
          ? new globalThis.TextDecoder("utf-8").decode(bytes)
          : String.fromCharCode.apply(null, Array.from(bytes));
      return JSON.parse(t);
    },
    clone() {
      return parseDataUrlInline(url);
    },
  };
}

export function installFetchFontsShim() {
  const g = globalThis;
  if (g.fetch && g.fetch[INSTALLED_MARKER]) return;

  const previousFetch =
    typeof g.fetch === "function" ? g.fetch.bind(g) : null;

  async function wrappedFetch(input, init) {
    const url = urlFromInput(input);

    if (url.startsWith("data:")) {
      if (previousFetch) {
        return previousFetch(input, init);
      }
      return parseDataUrlInline(url);
    }

    const base64 = findFontBase64ForUrl(url);
    if (base64 !== null) {
      return synthesizeFontResponse(base64ToBytes(base64), url);
    }

    throw new Error(`network fetch not allowed in CLI: ${url}`);
  }

  Object.defineProperty(wrappedFetch, INSTALLED_MARKER, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });

  Object.defineProperty(g, "fetch", {
    value: wrappedFetch,
    writable: true,
    configurable: true,
    enumerable: false,
  });

  // Mirror onto window (installed by dom.mjs) so code that reaches in via
  // `window.fetch` sees the same wrapper.
  const w = typeof g.window === "object" && g.window !== null ? g.window : null;
  if (w) {
    try {
      w.fetch = wrappedFetch;
    } catch {
      // linkedom's window may freeze some props; ignore.
    }
  }
}
