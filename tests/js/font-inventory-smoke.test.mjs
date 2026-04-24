// Minimal smoke test for the generated font inventory.
// Not the full FNT-003 integrity gate (that lives in font-inventory.test.mjs
// and hashes every WOFF2 against the installed npm tree).

import { describe, it, expect } from "vitest";
import { FONT_ASSETS } from "../../src/core/font-assets.mjs";

describe("font-assets smoke", () => {
  it("includes at least one Excalifont entry", () => {
    expect(Array.isArray(FONT_ASSETS.Excalifont)).toBe(true);
    expect(FONT_ASSETS.Excalifont.length).toBeGreaterThan(0);
    const first = FONT_ASSETS.Excalifont[0];
    expect(typeof first.path).toBe("string");
    expect(typeof first.base64).toBe("string");
    expect(first.base64.length).toBeGreaterThan(0);
  });

  it("Excalifont bytes decode to a WOFF2 magic header (wOF2)", () => {
    const first = FONT_ASSETS.Excalifont[0];
    const bytes = Uint8Array.from(Buffer.from(first.base64, "base64"));
    expect(bytes.length).toBeGreaterThan(4);
    // WOFF2 magic number per https://www.w3.org/TR/WOFF2/ §3 = 0x774F4632 "wOF2".
    const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
    expect(magic).toBe("wOF2");
  });

  it("object is frozen", () => {
    expect(Object.isFrozen(FONT_ASSETS)).toBe(true);
    expect(Object.isFrozen(FONT_ASSETS.Excalifont)).toBe(true);
    expect(Object.isFrozen(FONT_ASSETS.Excalifont[0])).toBe(true);
  });
});
