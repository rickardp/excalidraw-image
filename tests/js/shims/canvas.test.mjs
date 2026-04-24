// Unit tests for src/core/shims/canvas.mjs (J-005).
// Vitest, no jsdom — the DOM shim itself supplies document via linkedom.
// See PLAN.md §4.2 and upstream SVG_EXPORT.md §3.2.

import { describe, it, expect, beforeAll } from "vitest";

describe("installCanvasShim", () => {
  beforeAll(async () => {
    // Order matters: dom before canvas. The canvas shim wraps
    // document.createElement, so document must exist first.
    const { installDomShim } = await import(
      "../../../src/core/shims/dom.mjs"
    );
    installDomShim();
    const { installCanvasShim } = await import(
      "../../../src/core/shims/canvas.mjs"
    );
    installCanvasShim();
  });

  it("document.createElement('canvas') returns an object with getContext('2d')", () => {
    const canvas = globalThis.document.createElement("canvas");
    expect(canvas).toBeDefined();
    const ctx = canvas.getContext("2d");
    expect(ctx).toBeDefined();
    expect(typeof ctx.measureText).toBe("function");
  });

  it("measureText returns a positive width for a non-empty string", () => {
    const ctx = globalThis.document.createElement("canvas").getContext("2d");
    expect(ctx.measureText("abc").width).toBeGreaterThan(0);
  });

  it("honors a user-set font and still returns a positive width", () => {
    const ctx = globalThis.document.createElement("canvas").getContext("2d");
    ctx.font = "20px Virgil";
    expect(ctx.font).toBe("20px Virgil");
    const width = ctx.measureText("hello").width;
    expect(typeof width).toBe("number");
    expect(width).toBeGreaterThan(0);
  });

  it("placeholder width equals text.length * 8 (T-003 detection hook)", () => {
    const ctx = globalThis.document.createElement("canvas").getContext("2d");
    expect(ctx.measureText("abc").width).toBe(3 * 8);
    expect(ctx.measureText("").width).toBe(0);
    expect(ctx.measureText("hello world").width).toBe(11 * 8);
  });

  it("uppercase 'CANVAS' also triggers the shim", () => {
    const canvas = globalThis.document.createElement("CANVAS");
    expect(canvas).toBeDefined();
    const ctx = canvas.getContext("2d");
    expect(typeof ctx.measureText).toBe("function");
    expect(ctx.measureText("x").width).toBe(8);
  });

  it("non-canvas tags pass through to linkedom", () => {
    const div = globalThis.document.createElement("div");
    // linkedom's HTMLDivElement; at minimum it must be a Node with outerHTML.
    expect(div).toBeDefined();
    expect(typeof div.outerHTML).toBe("string");
    expect(div.tagName).toBe("DIV");
    // Element inheritance: any linkedom element exposes setAttribute.
    expect(typeof div.setAttribute).toBe("function");
    div.setAttribute("id", "x");
    expect(div.getAttribute("id")).toBe("x");
  });

  it("canvas context exposes the settable properties and no-op stubs the export path needs", () => {
    const ctx = globalThis.document.createElement("canvas").getContext("2d");
    // Defaults
    expect(typeof ctx.font).toBe("string");
    expect(ctx.font).toBe("10px sans-serif");
    // No-op stubs — must not throw, must return undefined.
    expect(ctx.save()).toBeUndefined();
    expect(ctx.restore()).toBeUndefined();
    expect(ctx.fillText("t", 0, 0)).toBeUndefined();
    expect(ctx.strokeText("t", 0, 0)).toBeUndefined();
    expect(ctx.setTransform(1, 0, 0, 1, 0, 0)).toBeUndefined();
  });

  it("canvas has settable numeric width/height defaulting to 0", () => {
    const canvas = globalThis.document.createElement("canvas");
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
    canvas.width = 200;
    canvas.height = 150;
    expect(canvas.width).toBe(200);
    expect(canvas.height).toBe(150);
  });

  it("is idempotent: calling installCanvasShim twice does not throw or double-wrap", async () => {
    const { installCanvasShim } = await import(
      "../../../src/core/shims/canvas.mjs"
    );
    const createBefore = globalThis.document.createElement;
    expect(() => installCanvasShim()).not.toThrow();
    expect(() => installCanvasShim()).not.toThrow();
    // The wrapper must still point to the same function after idempotent calls.
    expect(globalThis.document.createElement).toBe(createBefore);
    // And it must still route canvas → shim, not reach a stale linkedom path.
    const canvas = globalThis.document.createElement("canvas");
    expect(canvas.getContext("2d").measureText("ab").width).toBe(16);
  });
});
