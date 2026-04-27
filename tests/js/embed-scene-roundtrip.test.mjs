// tests/js/embed-scene-roundtrip.test.mjs — E-003
//
// Full round-trip gate: export a scene with `embedScene: true`, extract the
// base64 payload from between <!-- payload-start --> / <!-- payload-end -->,
// decode it back to {elements, appState, files}, assert the decoded scene
// matches the original modulo upstream normalizations.
//
// Decoder path: hand-rolled per upstream SVG_EXPORT.md §3.5 and
// packages/excalidraw/data/encode.ts. We cannot `import` from
// `@excalidraw/excalidraw/data/encode` — the npm dist ships a single
// bundled package whose `exports` map only surfaces the root `.` and type
// paths via `./*` (see node_modules/@excalidraw/excalidraw/package.json).
// `decodeSvgBase64Payload` is NOT re-exported from the root index.
//
// Pipeline (mirrors `encodeSvgBase64Payload` / `decode` in encode.ts):
//   1. Extract base64 text between `<!-- payload-start -->` and
//      `<!-- payload-end -->`.
//   2. `atob(base64)` -> JSON-string of the wrapper
//      `{ version, encoding: "bstring", compressed, encoded }`.
//   3. JSON.parse.
//   4. `wrapper.encoded` is a byte string (each char in 0..255) of the
//      pako-deflated UTF-8 bytes of the inner scene JSON.
//   5. Convert byte string -> Uint8Array via `charCodeAt`.
//   6. `pako.inflate(bytes, { to: "string" })` -> inner scene JSON string.
//   7. JSON.parse -> `{ type, version, source, elements, appState, files }`.
//
// Known upstream normalizations we deliberately do NOT assert against:
//   - `restoreElements` (applied on reopen, not on our decode) fills in
//     `version`, `versionNonce`, `lineHeight`, and other derived fields
//     with defaults — the implementation notes risk 4.
//   - The embedded scene's `appState` may carry additional export-related
//     state (exportBackground, viewBackgroundColor, etc.) that the caller
//     didn't set.
//   - `source` is rewritten to Excalidraw's package source URL at export
//     time (the upstream `getExportSource()` path in scene/export.ts).
// The assertions therefore focus on: element count, element id + type
// alignment, and byte-for-byte files round-trip.

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { inflate } from "pako";

const FIXTURES = [
  "basic-shapes",
  "text-wrapped",
  "mixed-script",
  "image",
  "frames",
];

/**
 * Decode an `.excalidraw.svg`-style SVG back to the embedded scene.
 * Exported-style helper — FNT-011 can reuse this verbatim.
 *
 * @param {string} svg
 * @returns {{ type: string, version: number, source: string,
 *             elements: any[], appState: object, files: object }}
 */
export function decodePayload(svg) {
  // Step 1: extract the base64 text block.
  // Pattern mirrors upstream `decodeSvgBase64Payload` in scene/export.ts.
  const match = svg.match(/<!-- payload-start -->\s*([\s\S]+?)\s*<!-- payload-end -->/);
  if (!match) {
    throw new Error("decodePayload: no payload-start/payload-end block found");
  }
  const base64 = match[1].replace(/\s/g, "");

  // Step 2: atob -> JSON string of the wrapper.
  // Upstream uses `stringToBase64(…, true /* is already byte string */)`
  // which is plain `window.btoa`, so plain `atob` reverses it.
  const wrapperJson = atob(base64);

  // Step 3: parse wrapper.
  const wrapper = JSON.parse(wrapperJson);
  if (!wrapper || typeof wrapper.encoded !== "string") {
    throw new Error(
      "decodePayload: wrapper missing `encoded` string field",
    );
  }

  // Step 4/5: byte-string -> Uint8Array.
  // `wrapper.encoded` is ALREADY a byte string (not a second round of
  // base64). This matches the `compressed=true` branch of upstream
  // `decode()` in data/encode.ts: when compressed, the byte string is fed
  // straight to `pako.inflate` via `byteStringToArrayBuffer`.
  let innerJson;
  if (wrapper.compressed) {
    const bytes = Uint8Array.from(wrapper.encoded, (c) => c.charCodeAt(0));
    innerJson = inflate(bytes, { to: "string" });
  } else {
    // Fallback path: uncompressed byte string -> UTF-8 string.
    const bytes = Uint8Array.from(wrapper.encoded, (c) => c.charCodeAt(0));
    innerJson = new TextDecoder("utf-8").decode(bytes);
  }

  // Step 7: parse inner scene JSON.
  const scene = JSON.parse(innerJson);
  return scene;
}

describe("E-003 embed-scene round-trip", () => {
  let render;

  beforeAll(async () => {
    globalThis.location ??= {
      href: "http://localhost/",
      origin: "http://localhost",
    };
    await import(resolve("dist/core.mjs"));
    render = globalThis.__render;
  });

  for (const name of FIXTURES) {
    it(`${name}: embed + decode preserves element count, ids, types, and files`, async () => {
      const path = `tests/fixtures/${name}.excalidraw`;
      const sceneText = readFileSync(path, "utf8");
      const original = JSON.parse(sceneText);

      const { svg } = await render(
        sceneText,
        JSON.stringify({ embedScene: true }),
      );

      const decoded = decodePayload(svg);

      // Sanity: wrapper is a well-formed Excalidraw scene.
      expect(decoded).toBeTruthy();
      expect(decoded.type).toBe("excalidraw");
      expect(Array.isArray(decoded.elements)).toBe(true);

      // 4.a — element count preserved.
      expect(decoded.elements.length).toBe(original.elements.length);

      // 4.b — id + type alignment per index.
      // (Not full deep-equal: upstream `restoreElements` on load will fill
      // derived fields — `version`, `versionNonce`, `lineHeight` defaults,
      // etc. — which are NOT in our hand-authored fixtures. Those
      // differences are expected per the implementation notes risk 4 and would cause
      // spurious failures here.)
      for (let i = 0; i < original.elements.length; i++) {
        const o = original.elements[i];
        const d = decoded.elements[i];
        expect(d.id, `element[${i}].id`).toBe(o.id);
        expect(d.type, `element[${i}].type`).toBe(o.type);
      }

      // 4.c — files round-trip byte-identically.
      // The export path does not normalize `files`; it serializes the
      // object as-is. Any difference here would be a real regression.
      const originalFiles = original.files ?? {};
      const decodedFiles = decoded.files ?? {};
      expect(JSON.stringify(decodedFiles)).toBe(JSON.stringify(originalFiles));
    });
  }
});
