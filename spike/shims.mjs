// spike/shims.mjs
// Minimal shim layer that must be installed BEFORE any @excalidraw/excalidraw
// code is evaluated. See PLAN.md §4.2 and SVG_EXPORT.md §5 for the design.
//
// Goal: get exportToSvg running under a plain ESM runtime (Deno + deno_core)
// with no React, no browser, no network. Everything is deliberately minimal
// for F-001; the real implementation lives in src/core/shims/*.
//
// If anything needs to be added to make exportToSvg run, document it in
// spike/README.md under "shims discovered empirically".

import { parseHTML } from "linkedom";

// -----------------------------------------------------------------------------
// 1. DOM: linkedom provides window/document/Node/Element/etc.
// -----------------------------------------------------------------------------
const { window, document } = parseHTML(
  "<!doctype html><html><body></body></html>",
);

// linkedom creates its own globals (well, objects). Mount them onto globalThis
// so Excalidraw's code (which expects a browser) can reach them.
globalThis.window = window;
globalThis.document = document;
globalThis.Node = window.Node;
globalThis.Element = window.Element;
globalThis.HTMLElement = window.HTMLElement;
globalThis.SVGElement = window.SVGElement;
globalThis.DocumentFragment = window.DocumentFragment;
globalThis.navigator = window.navigator ?? { userAgent: "excalidraw-image-spike" };
globalThis.location = window.location ?? { href: "http://localhost/" };
// Discovered empirically: chunk-K2UTITRG.js reads devicePixelRatio at
// module-eval time (static renderer init).
globalThis.devicePixelRatio = 1;
window.devicePixelRatio = 1;

// -----------------------------------------------------------------------------
// 2. base64: window.btoa / window.atob. Deno has globalThis.btoa/atob built-in,
//    but Excalidraw's data/encode.ts calls window.btoa explicitly.
// -----------------------------------------------------------------------------
window.btoa = globalThis.btoa;
window.atob = globalThis.atob;

// -----------------------------------------------------------------------------
// 3. FontFace + document.fonts stubs.
// -----------------------------------------------------------------------------
class FontFace {
  constructor(family, source, descriptors = {}) {
    this.family = family;
    this.source = source;
    this.style = descriptors.style ?? "normal";
    this.weight = descriptors.weight ?? "400";
    this.display = descriptors.display ?? "auto";
    this.unicodeRange = descriptors.unicodeRange ?? "U+0-10FFFF";
    this.status = "unloaded";
  }
  async load() {
    this.status = "loaded";
    return this;
  }
}
globalThis.FontFace = FontFace;
window.FontFace = FontFace;

const fontsSet = new Set();
const fontsStub = {
  add(font) {
    fontsSet.add(font);
    return this;
  },
  delete(font) {
    return fontsSet.delete(font);
  },
  clear() {
    fontsSet.clear();
  },
  has(font) {
    return fontsSet.has(font);
  },
  check() {
    return true;
  },
  load: async () => [],
  ready: Promise.resolve(undefined),
  forEach(cb) {
    fontsSet.forEach(cb);
  },
  [Symbol.iterator]() {
    return fontsSet[Symbol.iterator]();
  },
  get size() {
    return fontsSet.size;
  },
  addEventListener() {},
  removeEventListener() {},
};
document.fonts = fontsStub;
if (!window.document.fonts) window.document.fonts = fontsStub;

// -----------------------------------------------------------------------------
// 4. canvas shim: document.createElement("canvas") gives us a measureText impl.
//    For F-001 the metrics don't need to be accurate — we just need the code
//    path to not crash. A length-based heuristic (text.length * 8 at 10px) is
//    enough to render a scene with no user-defined text (basic-shapes has none).
// -----------------------------------------------------------------------------
const originalCreateElement = document.createElement.bind(document);
document.createElement = (tagName, options) => {
  const tag = String(tagName).toLowerCase();
  if (tag === "canvas") {
    return {
      tagName: "CANVAS",
      width: 0,
      height: 0,
      style: {},
      getContext(kind) {
        if (kind !== "2d") return null;
        return {
          font: "10px sans-serif",
          textBaseline: "alphabetic",
          textAlign: "start",
          fillStyle: "#000",
          strokeStyle: "#000",
          measureText(text) {
            // Very rough — good enough for F-001's no-text fixture.
            return { width: String(text).length * 8 };
          },
          fillText() {},
          strokeText() {},
          clearRect() {},
          save() {},
          restore() {},
          translate() {},
          scale() {},
          rotate() {},
          beginPath() {},
          closePath() {},
          moveTo() {},
          lineTo() {},
          fill() {},
          stroke() {},
          getImageData() {
            return { data: new Uint8ClampedArray(4) };
          },
          setTransform() {},
          drawImage() {},
        };
      },
      toDataURL() {
        return "data:image/png;base64,";
      },
    };
  }
  return originalCreateElement(tagName, options);
};
// Also install on window.document for any code that reaches in via window.
window.document.createElement = document.createElement;

// -----------------------------------------------------------------------------
// 5. fetch shim.
//    - Font asset URLs (anything containing "/fonts/" or ending ".woff2"): 404.
//      (F-001 does not exercise fonts — real font serving is J-004/FNT-002.)
//    - data: URLs: delegate to Deno's built-in fetch (Deno supports data:).
//    - Anything else: throw loudly so unexpected fetches are discovered.
// -----------------------------------------------------------------------------
const hostFetch = globalThis.fetch?.bind(globalThis);
globalThis.fetch = async (input, init) => {
  const url =
    typeof input === "string"
      ? input
      : input && typeof input.url === "string"
        ? input.url
        : String(input);

  if (url.includes("/fonts/") || url.endsWith(".woff2")) {
    return new Response(null, { status: 404 });
  }
  if (url.startsWith("data:")) {
    if (!hostFetch) {
      throw new Error(
        `spike fetch shim: data: URL requested but host fetch unavailable (${url.slice(0, 80)})`,
      );
    }
    return hostFetch(input, init);
  }
  throw new Error(
    `spike fetch shim: unexpected fetch for ${url} — extend the shim in spike/shims.mjs`,
  );
};
window.fetch = globalThis.fetch;

// -----------------------------------------------------------------------------
// 6. Disable Workers. Excalidraw's subset pipeline captures typeof Worker at
//    module evaluation; absent Worker forces the in-process path.
// -----------------------------------------------------------------------------
globalThis.Worker = undefined;
window.Worker = undefined;
