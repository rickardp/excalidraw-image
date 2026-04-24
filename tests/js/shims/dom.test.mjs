// Unit tests for src/core/shims/dom.mjs (J-001).
// Vitest; does NOT run in a jsdom environment — the shim itself must supply
// the DOM surface. See PLAN.md §4.2 and PHASE0.md Finding C.

import { describe, it, expect, beforeAll } from "vitest";

describe("installDomShim", () => {
  it("leaves globalThis.document undefined before installation", async () => {
    // Import the module without calling the installer to observe side-effect
    // purity at import time.
    await import("../../../src/core/shims/dom.mjs");
    expect(globalThis.document).toBeUndefined();
  });

  describe("after installation", () => {
    beforeAll(async () => {
      const { installDomShim } = await import(
        "../../../src/core/shims/dom.mjs"
      );
      installDomShim();
    });

    it("populates window and document on globalThis", () => {
      expect(globalThis.window).toBeDefined();
      expect(globalThis.document).toBeDefined();
    });

    it("sets devicePixelRatio to the numeric default 1", () => {
      expect(typeof globalThis.devicePixelRatio).toBe("number");
      expect(globalThis.devicePixelRatio).toBe(1);
    });

    it("installs window.location (J-010 finding)", () => {
      expect(globalThis.location).toBeDefined();
      expect(globalThis.location.origin).toBe("http://localhost");
      expect(globalThis.location.href).toBe("http://localhost/");
      expect(String(globalThis.location)).toBe("http://localhost/");
    });

    it("builds an SVG tree with correct namespace handling", () => {
      const svgNS = "http://www.w3.org/2000/svg";
      const svg = globalThis.document.createElementNS(svgNS, "svg");
      // linkedom's HTML-mode serializer does not emit the default xmlns on
      // createElementNS-rooted subtrees; Excalidraw's renderer sets it
      // explicitly before serialization, so we mirror that here.
      svg.setAttribute("xmlns", svgNS);
      const rect = globalThis.document.createElementNS(svgNS, "rect");
      rect.setAttributeNS(null, "width", "100");
      svg.appendChild(rect);
      // Namespace metadata is still correct on the element itself.
      expect(svg.namespaceURI).toBe(svgNS);
      expect(rect.namespaceURI).toBe(svgNS);
      const out = svg.outerHTML;
      expect(out).toContain('xmlns="http://www.w3.org/2000/svg"');
      expect(out).toContain("<rect");
      expect(out).toContain('width="100"');
    });

    it("is idempotent: calling twice does not throw or replace document", async () => {
      const { installDomShim } = await import(
        "../../../src/core/shims/dom.mjs"
      );
      const firstDocument = globalThis.document;
      expect(() => installDomShim()).not.toThrow();
      expect(() => installDomShim()).not.toThrow();
      expect(globalThis.document).toBe(firstDocument);
    });
  });
});
