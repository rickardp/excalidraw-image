// src/core/shims/canvas.mjs
//
// Canvas shim skeleton. See PLAN.md §4.2 and upstream SVG_EXPORT.md §3.2 for
// the measurement contract. Two measurement paths exist in Excalidraw's export
// code: the `CanvasTextMetricsProvider` (overridable) and a direct call in
// `scene/export.ts` for frame-label truncation
// (`document.createElement("canvas").getContext("2d").measureText(text).width`).
// The second path is why this shim is needed — it bypasses the provider hook.
//
// For J-005 `measureText` returns a placeholder `{ width: text.length * 8 }`.
// T-003 replaces that with fontkit-backed measurement; the placeholder width
// (exactly `text.length * 8`) is easy for T-003 tests to detect if they ever
// need to assert "fontkit has been wired in."
//
// Requires the DOM shim (J-001) so `document` and `HTMLElement` exist on
// globalThis. Host-neutral: no node:*, no fs, no path. Idempotent.

let installed = false;

// Marker class so `canvasObject instanceof HTMLCanvasElement` works if any
// code in the export path ever checks. Upstream Excalidraw does not appear to
// rely on this today, but the cost is trivial and it avoids a future surprise.
class HTMLCanvasElementShim {}

function makeContext2d() {
  const ctx = {
    // Settable font string. Default mirrors the browser's canvas default so
    // code that reads `.font` before writing it does not see `undefined`.
    font: "10px sans-serif",
    textBaseline: "alphabetic",
    textAlign: "start",
    fillStyle: "#000",
    strokeStyle: "#000",

    // Placeholder — T-003 replaces this with a fontkit-backed implementation
    // that honors `ctx.font`. The `* 8` factor is arbitrary but positive,
    // which is all Excalidraw's truncation path needs to produce *some* frame
    // label. Tests can detect the placeholder by the exact formula.
    measureText(text) {
      return { width: String(text).length * 8 };
    },

    // Minimal no-op stubs for the frame-label truncation path in
    // `scene/export.ts`. Rationale: silent no-ops are safer than throwing —
    // the only observable output is the SVG string, and these calls do not
    // contribute to it.
    save() {},
    restore() {},
    fillText() {},
    strokeText() {},
    setTransform() {},
  };
  return ctx;
}

function makeCanvas() {
  const canvas = {
    tagName: "CANVAS",
    nodeName: "CANVAS",
    width: 0,
    height: 0,
    style: {},
    getContext(kind) {
      if (kind !== "2d") return null;
      return makeContext2d();
    },
  };
  // Make `canvas instanceof HTMLCanvasElement` true without turning the
  // canvas into a real linkedom element (linkedom's HTMLCanvasElement, if it
  // had one, would not carry `getContext`). See the report for J-005.
  Object.setPrototypeOf(canvas, HTMLCanvasElementShim.prototype);
  return canvas;
}

export function installCanvasShim() {
  if (installed) return;
  if (typeof document === "undefined") {
    throw new Error("install dom shim first");
  }
  installed = true;

  // Expose the marker class globally so `instanceof` works from any scope.
  Object.defineProperty(globalThis, "HTMLCanvasElement", {
    value: HTMLCanvasElementShim,
    writable: true,
    configurable: true,
    enumerable: false,
  });
  if (typeof window !== "undefined") {
    window.HTMLCanvasElement = HTMLCanvasElementShim;
  }

  const orig = document.createElement.bind(document);
  const wrapped = (tag, ...rest) => {
    if (String(tag).toLowerCase() === "canvas") return makeCanvas();
    return orig(tag, ...rest);
  };

  document.createElement = wrapped;
  // Mirror on window.document in case any code reaches in via window.
  if (typeof window !== "undefined" && window.document) {
    window.document.createElement = wrapped;
  }
}
