// src/core/shims/fonts.mjs
//
// Installs minimal FontFace + document.fonts stubs. See PLAN.md §4.2 and §4A.6.
// We do NOT actually load or measure fonts here — that is Excalidraw's concern
// via its own subsetter and fontkit. This shim just has to preserve descriptors
// verbatim and satisfy the FontFaceSet surface that Excalidraw's export path
// probes (add/has/check/load/ready).
//
// Requires the DOM shim (J-001) to have installed `document` first.
// Host-neutral: no node:*, no fs, no path. Idempotent.

let installed = false;

export function installFontsShim() {
  if (installed) return;
  if (typeof document === "undefined") {
    throw new Error("install dom shim first");
  }
  installed = true;

  class FontFace {
    constructor(family, source, descriptors = {}) {
      this.family = family;
      this.source = source;
      this.style = descriptors.style ?? "normal";
      this.weight = descriptors.weight ?? "400";
      this.display = descriptors.display ?? "auto";
      this.unicodeRange = descriptors.unicodeRange ?? "U+0-10FFFF";
      this.status = "unloaded";
      this.loaded = Promise.resolve(this);
    }
    load() {
      this.status = "loaded";
      return Promise.resolve(this);
    }
  }

  const fontsSet = new Set();
  const fontFaceSet = {
    add(fontFace) {
      fontsSet.add(fontFace);
      return this;
    },
    delete(fontFace) {
      return fontsSet.delete(fontFace);
    },
    clear() {
      fontsSet.clear();
    },
    has(fontFace) {
      return fontsSet.has(fontFace);
    },
    // We don't actually check availability — Excalidraw only uses this
    // as a gate; returning true short-circuits the load-wait path.
    check() {
      return true;
    },
    load() {
      return Promise.resolve([]);
    },
    forEach(cb, thisArg) {
      fontsSet.forEach((font) => cb.call(thisArg, font, font, fontFaceSet));
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
  fontFaceSet.ready = Promise.resolve(fontFaceSet);

  const defineGlobal = (name, value) => {
    Object.defineProperty(globalThis, name, {
      value,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  };

  defineGlobal("FontFace", FontFace);
  if (typeof window !== "undefined") {
    window.FontFace = FontFace;
  }

  // document.fonts — linkedom does not expose a FontFaceSet, so we install
  // ours directly. Use defineProperty so a host that pre-defines a getter
  // (unlikely, but observed on some jsdom versions) is overridden.
  Object.defineProperty(document, "fonts", {
    value: fontFaceSet,
    writable: true,
    configurable: true,
    enumerable: false,
  });
}
