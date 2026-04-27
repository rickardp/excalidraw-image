// tests/js/embed-scene-serialization.test.mjs — E-002
//
// E-002 hardens the E-001 marker-presence gate by inspecting the
// internal structure of the <metadata> block that carries the embedded
// scene. This is the implementation notes risk 6: linkedom could in principle collapse
// comments, reorder children, or mangle text-node whitespace during
// outerHTML serialization. If that happens, the Excalidraw round-trip
// decoder (which this test does NOT run — E-003 owns that) will fail
// silently or cryptically. Better to catch it here with structural
// assertions, and document mitigation rather than silently patching.
//
// Scope vs neighbors:
//   - E-001 (embed-scene.test.mjs) confirms the four marker tokens appear
//     somewhere in the SVG. It does not care about ordering inside
//     <metadata> or about XML well-formedness.
//   - E-002 (this file) asserts: (a) the payload-type and payload-version
//     comments appear before payload-start, (b) the base64 body is
//     non-empty, base64-clean (post-whitespace-strip), and >100 chars,
//     (c) child ordering inside <metadata> is preserved, (d) the whole
//     SVG is well-formed XML per xmllint.
//   - E-003 (roundtrip.test.mjs) will decode the payload and deep-equal
//     elements/files. Out of scope here.
//
// If any assertion here fails, linkedom is dropping/reordering something.
// Do NOT patch linkedom's output in this task — document the failure and
// reopen E-002 with a mitigation plan (§11 risk 6's fallback is a hand-
// written <metadata> string injected post-serialization).

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

describe("E-002 metadata payload serialization strictness", () => {
  let svgEmbed;
  let metadataBlock;

  beforeAll(async () => {
    globalThis.location ??= { href: "http://localhost/", origin: "http://localhost" };
    await import(resolve("dist/core.mjs"));
    const scene = readFileSync("tests/fixtures/basic-shapes.excalidraw", "utf8");
    const r = await globalThis.__render(scene, JSON.stringify({ embedScene: true }));
    svgEmbed = r.svg;

    // Extract the <metadata>…</metadata> block. Upstream emits the
    // element unconditionally, so this match must succeed even if its
    // children get collapsed; the later structural assertions are what
    // catch collapse.
    const metaMatch = svgEmbed.match(/<metadata>([\s\S]*?)<\/metadata>/);
    if (!metaMatch) {
      throw new Error(
        "E-002: <metadata>…</metadata> block not found in SVG — linkedom " +
          "may have self-closed or dropped the element entirely.",
      );
    }
    metadataBlock = metaMatch[1];
  });

  it("payload-type comment appears before payload-start", () => {
    // Accept either the fully-qualified mime comment or any generic
    // `payload-type:` comment, since the exact mime string is owned by
    // Excalidraw's export path and we don't want to couple this test to
    // it. What matters is *order*: the type declaration must precede the
    // payload body so downstream parsers can branch on it.
    const typeIdx = metadataBlock.indexOf("payload-type:");
    const startIdx = metadataBlock.indexOf("payload-start");
    expect(typeIdx, "no `payload-type:` comment found inside <metadata>").toBeGreaterThanOrEqual(0);
    expect(startIdx, "no `payload-start` marker found inside <metadata>").toBeGreaterThanOrEqual(0);
    expect(typeIdx, "payload-type must appear before payload-start").toBeLessThan(startIdx);

    // Prefer the exact mime if present (documentation signal, not a hard
    // failure if Excalidraw ever renames the mime).
    if (!metadataBlock.includes("<!-- payload-type:application/vnd.excalidraw+json -->")) {
      console.warn(
        "E-002: payload-type mime is not the expected " +
          "`application/vnd.excalidraw+json` — test is still passing on the " +
          "generic `payload-type:` prefix. Double-check upstream for a rename.",
      );
    }
  });

  it("payload-version comment appears before payload-start", () => {
    const versionMatch = metadataBlock.match(/<!-- payload-version:(\d+) -->/);
    const startIdx = metadataBlock.indexOf("payload-start");
    expect(versionMatch, "no `<!-- payload-version:N -->` comment inside <metadata>").toBeTruthy();

    const versionIdx = metadataBlock.indexOf(versionMatch[0]);
    expect(versionIdx, "payload-version must appear before payload-start").toBeLessThan(startIdx);
  });

  it("base64 payload is non-empty, base64-clean, and >100 chars", () => {
    const m = metadataBlock.match(/<!-- payload-start -->\s*([A-Za-z0-9+/=\s]+?)\s*<!-- payload-end -->/s);
    expect(m, "payload-start/payload-end regex did not match inside <metadata>").toBeTruthy();

    const captured = m[1];
    expect(captured.length, "captured payload group is empty").toBeGreaterThan(0);

    const clean = captured.replace(/\s/g, "");
    expect(clean, "base64 payload is not base64-clean after whitespace strip").toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(clean.length, "base64 payload is unexpectedly short (<100 chars)").toBeGreaterThan(100);
  });

  it("child order inside <metadata> is preserved: type → start → body → end", () => {
    // Extract the raw payload body (the base64 text node) so we can
    // locate it inside the metadata block directly, without the comment
    // boundaries. This is what catches linkedom reordering the text node
    // outside of the start/end fence.
    const m = metadataBlock.match(/<!-- payload-start -->\s*([A-Za-z0-9+/=\s]+?)\s*<!-- payload-end -->/s);
    expect(m).toBeTruthy();
    const payloadBodyClean = m[1].replace(/\s/g, "");
    // Probe with the first 32 base64 chars — long enough to be unique,
    // short enough to survive any benign whitespace wrapping linkedom
    // might apply to the text node.
    const probe = payloadBodyClean.slice(0, 32);

    const idxType = metadataBlock.indexOf("payload-type:");
    const idxStart = metadataBlock.indexOf("<!-- payload-start -->");
    const idxBody = metadataBlock.indexOf(probe);
    const idxEnd = metadataBlock.indexOf("<!-- payload-end -->");

    expect(idxType, "payload-type: not present").toBeGreaterThanOrEqual(0);
    expect(idxStart, "<!-- payload-start --> not present").toBeGreaterThanOrEqual(0);
    expect(idxBody, "base64 body probe not found inside <metadata>").toBeGreaterThanOrEqual(0);
    expect(idxEnd, "<!-- payload-end --> not present").toBeGreaterThanOrEqual(0);

    expect(idxType, "payload-type must precede payload-start").toBeLessThan(idxStart);
    expect(idxStart, "payload-start must precede base64 body").toBeLessThan(idxBody);
    expect(idxBody, "base64 body must precede payload-end").toBeLessThan(idxEnd);
  });

  it("whole SVG is well-formed XML per xmllint (skipped if unavailable)", () => {
    // xmllint is a libxml2 CLI — ubiquitous on macOS/Linux CI runners but
    // not guaranteed. Skip gracefully if missing; well-formedness is a
    // nice-to-have extra layer on top of the structural assertions above.
    const dir = mkdtempSync(resolve(tmpdir(), "excalidraw-e002-"));
    const path = resolve(dir, "out.svg");
    writeFileSync(path, svgEmbed, "utf8");

    try {
      execFileSync("xmllint", ["--noout", "--nowarning", path], {
        stdio: ["ignore", "ignore", "pipe"],
      });
      // exit 0 => well-formed; no assertion needed beyond "did not throw".
    } catch (err) {
      // ENOENT => xmllint not installed; skip.
      if (err && err.code === "ENOENT") {
        console.warn("E-002: xmllint not found on PATH; skipping well-formed-XML assertion.");
        return;
      }
      // Non-zero exit => malformed XML. Surface xmllint's stderr so the
      // agent reopening this task can see which line/offset tripped.
      const stderr = err && err.stderr ? err.stderr.toString() : String(err);
      throw new Error(
        "E-002: xmllint reported the SVG is not well-formed XML — linkedom " +
          "may have emitted stray/unescaped chars inside <metadata> or the " +
          "base64 body. xmllint stderr:\n" + stderr,
      );
    }
  });
});
