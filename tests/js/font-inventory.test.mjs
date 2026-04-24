// FNT-003 — Font inventory integrity gate (PLAN §4A.8 gate 1).
//
// Verifies that every WOFF2 file in
//   node_modules/@excalidraw/excalidraw/dist/prod/fonts/
// is present in src/core/font-assets.mjs, byte-identical (compared via
// SHA-256 of the decoded base64 against the hash of the file on disk),
// and vice versa. A dep bump that adds, removes, or modifies a WOFF2
// must trip this gate and produce a diff.
//
// This is a test/tooling script, NOT host-neutral src/core/ code —
// node:fs, node:path, node:crypto are explicitly allowed here.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { createHash } from "node:crypto";
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

/** Walk a directory recursively and return absolute file paths. */
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) {
      out.push(...walk(abs));
    } else if (st.isFile()) {
      out.push(abs);
    }
  }
  return out;
}

/** Normalize a path segment to forward slashes, matching FONT_ASSETS entries. */
function toPosix(p) {
  return sep === "/" ? p : p.split(sep).join("/");
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Run the full comparison against a supplied inventory map.
 * Returns { discrepancies: string[] }.
 */
function compareInventory(inventoryMap) {
  const discrepancies = [];

  // Build { relPath -> sha256 } from disk.
  const diskHashes = new Map();
  const absFiles = walk(FONT_DIR)
    .filter((p) => p.toLowerCase().endsWith(".woff2"))
    .sort();
  for (const abs of absFiles) {
    const rel = toPosix(relative(FONT_DIR, abs));
    diskHashes.set(rel, sha256Bytes(readFileSync(abs)));
  }

  // Build { relPath -> sha256 } from inventory.
  const inventoryHashes = new Map();
  for (const [family, entries] of Object.entries(inventoryMap)) {
    if (!Array.isArray(entries)) {
      discrepancies.push(
        `family ${JSON.stringify(family)}: expected an array, got ${typeof entries}`,
      );
      continue;
    }
    for (const entry of entries) {
      if (!entry || typeof entry.path !== "string" || typeof entry.base64 !== "string") {
        discrepancies.push(
          `family ${JSON.stringify(family)}: malformed entry ${JSON.stringify(entry)}`,
        );
        continue;
      }
      const rel = toPosix(entry.path);
      if (inventoryHashes.has(rel)) {
        discrepancies.push(`duplicate inventory entry for path: ${rel}`);
        continue;
      }
      let bytes;
      try {
        // Node's Buffer.from is available; Buffer is a Uint8Array, OK for hashing.
        bytes = Buffer.from(entry.base64, "base64");
      } catch (err) {
        discrepancies.push(`base64 decode failed for ${rel}: ${err.message}`);
        continue;
      }
      inventoryHashes.set(rel, sha256Bytes(bytes));
    }
  }

  // 1. On disk but missing from inventory.
  const missingFromInventory = [];
  for (const rel of diskHashes.keys()) {
    if (!inventoryHashes.has(rel)) missingFromInventory.push(rel);
  }
  // 2. In inventory but missing from disk.
  const missingFromDisk = [];
  for (const rel of inventoryHashes.keys()) {
    if (!diskHashes.has(rel)) missingFromDisk.push(rel);
  }
  // 3. Present in both but hash mismatch.
  const hashMismatches = [];
  for (const [rel, diskHash] of diskHashes.entries()) {
    const invHash = inventoryHashes.get(rel);
    if (invHash !== undefined && invHash !== diskHash) {
      hashMismatches.push({ path: rel, disk: diskHash, inventory: invHash });
    }
  }

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
  if (hashMismatches.length > 0) {
    discrepancies.push(
      `sha256 mismatches (${hashMismatches.length}):\n  ` +
        hashMismatches
          .sort((a, b) => a.path.localeCompare(b.path))
          .map(
            (m) =>
              `${m.path}\n    disk:      ${m.disk}\n    inventory: ${m.inventory}`,
          )
          .join("\n  "),
    );
  }

  return {
    discrepancies,
    diskFileCount: diskHashes.size,
    inventoryEntryCount: inventoryHashes.size,
  };
}

describe("font inventory integrity (FNT-003)", () => {
  it("every WOFF2 on disk matches FONT_ASSETS byte-for-byte (and vice versa)", () => {
    const result = compareInventory(FONT_ASSETS);
    if (result.discrepancies.length > 0) {
      const msg =
        `FONT_ASSETS is out of sync with ${FONT_DIR}\n` +
        `disk files: ${result.diskFileCount}, inventory entries: ${result.inventoryEntryCount}\n\n` +
        result.discrepancies.join("\n\n");
      // Use expect with a descriptive message so the diff is visible in CI logs.
      expect.soft(result.discrepancies, msg).toEqual([]);
    }
    // Hard assertion: all discrepancies must be empty.
    expect(result.discrepancies).toEqual([]);
    // Sanity: non-trivial file count — catches a silently-empty fonts dir.
    expect(result.diskFileCount).toBeGreaterThan(0);
    expect(result.inventoryEntryCount).toBe(result.diskFileCount);
  });

  it("catches corruption: flipping one base64 char is detected as a hash mismatch", () => {
    // Clone FONT_ASSETS and flip a single base64 character in one entry.
    // We decode, flip a byte, re-encode — equivalently, we flip the first
    // non-header base64 character deterministically.
    const family = Object.keys(FONT_ASSETS)[0];
    const original = FONT_ASSETS[family][0];
    expect(original.base64.length).toBeGreaterThan(32);
    // Flip a character ~middle of the base64 string so it actually changes
    // the decoded bytes. Map 'A'<->'B', else toggle case.
    const idx = Math.floor(original.base64.length / 2);
    const ch = original.base64[idx];
    const flipped =
      ch === "A"
        ? "B"
        : ch === "B"
          ? "A"
          : ch === ch.toLowerCase()
            ? ch.toUpperCase()
            : ch.toLowerCase();
    // If the char is not a letter (digit / + / /), fall back to a digit swap.
    const safeFlipped = /[A-Za-z]/.test(ch)
      ? flipped
      : ch === "0"
        ? "1"
        : "0";
    const corruptedBase64 =
      original.base64.slice(0, idx) + safeFlipped + original.base64.slice(idx + 1);
    expect(corruptedBase64).not.toBe(original.base64);

    const corruptedMap = {
      ...Object.fromEntries(
        Object.entries(FONT_ASSETS).map(([k, v]) => [k, [...v]]),
      ),
    };
    corruptedMap[family] = [
      { path: original.path, base64: corruptedBase64 },
      ...FONT_ASSETS[family].slice(1),
    ];

    const result = compareInventory(corruptedMap);
    expect(result.discrepancies.length).toBeGreaterThan(0);
    expect(result.discrepancies.join("\n")).toMatch(/sha256 mismatches/);
    expect(result.discrepancies.join("\n")).toContain(original.path);
  });
});
