// FNT-003 — Font inventory integrity gate (PLAN §4A.8 gate 1).
//
// Verifies that every WOFF2 file in
//   node_modules/@excalidraw/excalidraw/dist/prod/fonts/
// has a corresponding `path` entry in src/core/font-assets.mjs (and vice
// versa). After the font-split refactor, byte-content verification has
// moved to the font sub-crates' fingerprint metadata + `npm run check:fonts`;
// this gate stays as the JS-level path-coverage check.
//
// This is a test/tooling script, NOT host-neutral src/core/ code —
// node:fs, node:path are explicitly allowed here.

import { describe, it, expect } from "vitest";
import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { FONT_ASSETS } from "../../src/core/font-assets.mjs";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const FONT_DIR = join(
  REPO_ROOT,
  "node_modules",
  "@excalidraw",
  "excalidraw",
  "dist",
  "prod",
  "fonts",
);

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) out.push(...walk(abs));
    else if (st.isFile()) out.push(abs);
  }
  return out;
}

function toPosix(p) {
  return sep === "/" ? p : p.split(sep).join("/");
}

function comparePaths(inventoryMap) {
  const discrepancies = [];

  const diskPaths = new Set(
    walk(FONT_DIR)
      .filter((p) => p.toLowerCase().endsWith(".woff2"))
      .map((abs) => toPosix(relative(FONT_DIR, abs))),
  );

  const inventoryPaths = new Set();
  for (const [family, entries] of Object.entries(inventoryMap)) {
    if (!Array.isArray(entries)) {
      discrepancies.push(`family ${JSON.stringify(family)}: not an array`);
      continue;
    }
    for (const entry of entries) {
      if (!entry || typeof entry.path !== "string") {
        discrepancies.push(
          `family ${JSON.stringify(family)}: malformed entry ${JSON.stringify(entry)}`,
        );
        continue;
      }
      if (inventoryPaths.has(entry.path)) {
        discrepancies.push(`duplicate path: ${entry.path}`);
      }
      inventoryPaths.add(entry.path);
    }
  }

  const missingFromInventory = [...diskPaths].filter((p) => !inventoryPaths.has(p));
  const missingFromDisk = [...inventoryPaths].filter((p) => !diskPaths.has(p));

  if (missingFromInventory.length > 0) {
    discrepancies.push(
      `files on disk but missing from FONT_ASSETS (${missingFromInventory.length}):\n  ` +
        missingFromInventory.sort().join("\n  "),
    );
  }
  if (missingFromDisk.length > 0) {
    discrepancies.push(
      `entries in FONT_ASSETS but missing on disk (${missingFromDisk.length}):\n  ` +
        missingFromDisk.sort().join("\n  "),
    );
  }

  return {
    discrepancies,
    diskFileCount: diskPaths.size,
    inventoryEntryCount: inventoryPaths.size,
  };
}

describe("font inventory integrity (FNT-003)", () => {
  it("FONT_ASSETS path set matches the npm dist's WOFF2s 1:1", () => {
    const result = comparePaths(FONT_ASSETS);
    if (result.discrepancies.length > 0) {
      const msg =
        `FONT_ASSETS is out of sync with ${FONT_DIR}\n` +
        `disk files: ${result.diskFileCount}, inventory entries: ${result.inventoryEntryCount}\n\n` +
        result.discrepancies.join("\n\n");
      expect.soft(result.discrepancies, msg).toEqual([]);
    }
    expect(result.discrepancies).toEqual([]);
    expect(result.diskFileCount).toBeGreaterThan(0);
    expect(result.inventoryEntryCount).toBe(result.diskFileCount);
  });

  it("catches a missing path: dropping an entry surfaces as 'missing from FONT_ASSETS'", () => {
    // Clone FONT_ASSETS and remove the first entry of the first family.
    const families = Object.keys(FONT_ASSETS);
    const family = families[0];
    const cloned = Object.fromEntries(
      families.map((f) => [f, [...FONT_ASSETS[f]]]),
    );
    cloned[family] = cloned[family].slice(1);
    const result = comparePaths(cloned);
    expect(result.discrepancies.length).toBeGreaterThan(0);
    const msg = result.discrepancies.join("\n");
    expect(msg).toMatch(/missing from FONT_ASSETS/);
  });
});
