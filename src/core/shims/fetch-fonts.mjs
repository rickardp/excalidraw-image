// src/core/shims/fetch-fonts.mjs
//
// Installs a `globalThis.fetch` wrapper that:
//   1. Serves Excalidraw's bundled WOFF2 font assets from
//      `globalThis.__embeddedFonts` (populated by the host before render —
//      Rust shell loads from sub-crate FONTS arrays; Deno dev path reads
//      from node_modules/...).
//   2. Delegates `data:` URLs to the previous (host) fetch if present, or
//      parses them inline to a Response-like fallback.
//   3. Throws `Error("network fetch not allowed in CLI: <url>")` for any
//      other URL — see the implementation notes and §4A.7.
//
// Host-neutral: no node:*, no fs, no Buffer. Idempotent — calling install
// twice leaves a single wrapper in place.

import { FONT_PATHS } from "../font-assets.mjs";

const INSTALLED_MARKER = Symbol.for("excalidraw-image.fetch-fonts.installed");

// All known font paths (e.g. "Excalifont/Excalifont-Regular-<hash>.woff2"),
// pre-flattened from FONT_PATHS at module load. Bytes are looked up at fetch
// time from globalThis.__embeddedFonts[path].
const KNOWN_PATHS = (() => {
  const out = [];
  for (const entries of Object.values(FONT_PATHS)) {
    for (const entry of entries) out.push(entry.path);
  }
  return out;
})();

function findFontPathForUrl(url) {
  // Excalidraw requests fonts via
  //   <PKG_NAME>@<PKG_VERSION>/dist/prod/fonts/<Family>/<filename>.woff2
  // We match by suffix so any host/CDN prefix works.
  for (const path of KNOWN_PATHS) {
    if (url.endsWith(path)) return path;
  }
  return null;
}

function lookupFontBytes(path) {
  // The host (Rust shell or Deno dev entry) populates this global with a
  // map of path → Uint8Array before invoking __render. If it's missing or
  // doesn't contain the requested path, we throw a clear error.
  const map = globalThis.__embeddedFonts;
  if (!map) {
    throw new Error(
      `font asset requested but globalThis.__embeddedFonts not populated by host: ${path}`,
    );
  }
  const bytes = map[path];
  if (!bytes) {
    throw new Error(`font asset not loaded by host: ${path}`);
  }
  return bytes;
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
    const bin = globalThis.atob(payload);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
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

    const path = findFontPathForUrl(url);
    if (path !== null) {
      const bytes = lookupFontBytes(path);
      const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      return synthesizeFontResponse(view, url);
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
