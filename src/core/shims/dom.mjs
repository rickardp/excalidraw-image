// src/core/shims/dom.mjs
//
// Installs the linkedom-backed DOM surface Excalidraw's export path needs.
// See PLAN.md §4.2 and PHASE0.md Finding C. Host-neutral: no node:*, no fs,
// no path. Caller (J-007's install.mjs) decides when to run this.

import { parseHTML } from "linkedom";

let installed = false;

export function installDomShim() {
  if (installed) return;
  installed = true;

  const { window } = parseHTML("<!doctype html><html><body></body></html>");

  // Some hosts (recent Node.js) expose certain window globals as
  // read-only accessors on globalThis. Use defineProperty to override.
  const assign = (name, value) => {
    Object.defineProperty(globalThis, name, {
      value,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  };

  assign("window", window);
  assign("document", window.document);
  assign("navigator", window.navigator);
  assign("Node", window.Node);
  assign("Element", window.Element);
  assign("HTMLElement", window.HTMLElement);
  assign("SVGElement", window.SVGElement);
  assign("DocumentFragment", window.DocumentFragment);

  // PHASE0.md Finding C: Excalidraw's renderer chunk reads devicePixelRatio
  // at module-eval time. Defensive default.
  if (globalThis.devicePixelRatio === undefined) {
    globalThis.devicePixelRatio = 1;
  }
}
