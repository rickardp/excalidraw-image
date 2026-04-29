#!/usr/bin/env node
// Populate crates/excalidraw-image-fonts-{core,cjk,cjk-extra}/fonts/ from
// node_modules/@excalidraw/excalidraw/dist/prod/fonts/.
//
// Each WOFF2 font shard is decompressed to TTF (via wawoff2, WASM-based) and
// then brotli-compressed at quality 11, producing `.ttf.br` files. This
// eliminates the C++ build-time dependency (woofwoof / Google woff2 lib) that
// previously blocked Linux ARM64 cross-compilation.
//
// We deliberately do NOT commit the font binaries to git. The crates'
// fonts/ directories are .gitignored; this script materializes them at
// build/publish time. Keeps the source tree text-only and gives us one
// source of truth (the upstream npm package, integrity-pinned via
// package-lock.json).
//
// Partitioning:
//   * Every non-Xiaolai family (Assistant, Cascadia, ComicShanns,
//     Excalifont, Liberation, Lilita, Nunito, Virgil) goes into
//     fonts-core. These are all Latin-script + small companion ranges.
//   * Xiaolai shards are inspected one-by-one with fontkit. Each shard's
//     cmap is histogrammed against named Unicode blocks; the shard's
//     dominant block decides the destination crate:
//       - CJK Extension A, CJK Compat Ideographs, and uncategorized
//         long-tail ranges (Hangul Jamo, Kangxi Radicals, CJK Radicals
//         Supplement) → fonts-cjk-extra
//       - everything else (CJK Unified, Hangul Syllables, Hiragana,
//         Katakana, Bopomofo, etc.) → fonts-cjk
//
// Determinism is critical because the populated tree is fingerprinted by
// `npm run check:fonts` against [package.metadata.font-fingerprint] in
// each crate's Cargo.toml. Drift (npm package changed; partition logic
// changed) shows up immediately as a fingerprint mismatch.
//
// Modes:
//   * default                   → populate fonts/ only. Idempotent.
//                                 Used by `make bootstrap` and CI.
//   * `--bump`                  → populate fonts/, then for each crate,
//                                 if the populated fingerprint != the
//                                 recorded fingerprint, increment the
//                                 patch version + rewrite the recorded
//                                 sha256/file_count in Cargo.toml. Used
//                                 by humans after upgrading the
//                                 @excalidraw/excalidraw npm version.

import {
  readFileSync, readdirSync, rmSync, mkdirSync, writeFileSync, statSync,
} from "node:fs";
import { join, basename, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { brotliCompressSync, constants } from "node:zlib";
import * as fontkit from "fontkit";
import wawoff2 from "wawoff2";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const SRC_FONTS = join(REPO, "node_modules/@excalidraw/excalidraw/dist/prod/fonts");
const CRATES = [
  { key: "core",     dir: join(REPO, "crates/excalidraw-image-fonts-core") },
  { key: "cjk",      dir: join(REPO, "crates/excalidraw-image-fonts-cjk") },
  { key: "cjkExtra", dir: join(REPO, "crates/excalidraw-image-fonts-cjk-extra") },
];

const BUCKETS = [
  ["Latin/Greek/Cyrillic",  0x0000, 0x04FF],
  ["General Punctuation",   0x2000, 0x206F],
  ["CJK Symbols & Punct",   0x3000, 0x303F],
  ["Hiragana",              0x3040, 0x309F],
  ["Katakana",              0x30A0, 0x30FF],
  ["Bopomofo",              0x3100, 0x312F],
  ["Hangul Compat Jamo",    0x3130, 0x318F],
  ["Enclosed CJK",          0x3200, 0x32FF],
  ["CJK Compat",            0x3300, 0x33FF],
  ["CJK Ext A",             0x3400, 0x4DBF],
  ["CJK Unified",           0x4E00, 0x9FFF],
  ["Hangul Syllables",      0xAC00, 0xD7AF],
  ["CJK Compat Ideographs", 0xF900, 0xFAFF],
  ["Halfwidth/Fullwidth",   0xFF00, 0xFFEF],
  ["CJK Ext B+",            0x20000, 0x3FFFF],
];
const EXTRA_BUCKETS = new Set([
  "CJK Ext A",
  "CJK Compat Ideographs",
  "CJK Ext B+",
  "Other",
]);
const bucketOf = (cp) => {
  for (const [name, lo, hi] of BUCKETS) if (cp >= lo && cp <= hi) return name;
  return "Other";
};

function dominantBucket(woff2Bytes) {
  const font = fontkit.create(woff2Bytes);
  const counts = new Map();
  for (const cp of font.characterSet) {
    const b = bucketOf(cp);
    counts.set(b, (counts.get(b) || 0) + 1);
  }
  let best = "Other", bestN = 0;
  for (const [b, n] of counts) if (n > bestN) { bestN = n; best = b; }
  return best;
}

function wipeDir(p) {
  rmSync(p, { recursive: true, force: true });
  mkdirSync(p, { recursive: true });
}

async function convertShard(srcPath, fontsDir, family) {
  mkdirSync(join(fontsDir, family), { recursive: true });
  const woff2Bytes = readFileSync(srcPath);
  const ttfBytes = await wawoff2.decompress(woff2Bytes);
  const brBytes = brotliCompressSync(Buffer.from(ttfBytes), {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
  });
  const outName = basename(srcPath).replace(/\.woff2$/i, ".ttf.br");
  writeFileSync(join(fontsDir, family, outName), brBytes);
}

// Mirror of src/scripts/check-font-fingerprints.mjs:hashCrate. The two
// implementations must stay byte-identical — they share the recorded
// fingerprint format.
function walkFontFiles(dir, root = dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walkFontFiles(full, root, out);
    else if (st.isFile() && name.toLowerCase().endsWith(".ttf.br")) out.push(full);
  }
  return out;
}
function fingerprintFontsDir(fontsDir) {
  const files = walkFontFiles(fontsDir).sort();
  const lines = files.map((p) => {
    const rel = relative(fontsDir, p).split("\\").join("/");
    const sha = createHash("sha256").update(readFileSync(p)).digest("hex");
    return `${rel}:${sha}`;
  });
  return {
    fingerprint: createHash("sha256").update(lines.join("\n")).digest("hex"),
    count: files.length,
  };
}

function readCargo(cargoPath) {
  return readFileSync(cargoPath, "utf8");
}
function readRecorded(toml) {
  const block = toml.match(/\[package\.metadata\.font-fingerprint\]([\s\S]*?)(?=\n\[|$)/);
  if (!block) return { fingerprint: null, count: null };
  return {
    fingerprint: block[1].match(/sha256\s*=\s*"([^"]+)"/m)?.[1] ?? null,
    count: parseInt(block[1].match(/file_count\s*=\s*(\d+)/m)?.[1] ?? "-1", 10),
  };
}
function readVersion(toml) {
  // Match the package's own version, not a dependency line. The [package]
  // table has version on its own line at the top of the section.
  const m = toml.match(/^\[package\][\s\S]*?\nversion\s*=\s*"([^"]+)"/m);
  if (!m) throw new Error("could not parse [package].version");
  return m[1];
}
function bumpPatch(version) {
  const m = version.match(/^(\d+)\.(\d+)\.(\d+)(.*)$/);
  if (!m) throw new Error(`unexpected non-semver version "${version}"`);
  const [, maj, min, pat, rest] = m;
  return `${maj}.${min}.${parseInt(pat, 10) + 1}${rest}`;
}
function rewriteCargo(toml, { newVersion, newSha, newCount }) {
  // Replace only the [package].version line, leaving any deps that
  // happen to have version="..." entries alone.
  let out = toml.replace(
    /(\[package\][\s\S]*?\nversion\s*=\s*)"[^"]+"/m,
    `$1"${newVersion}"`,
  );
  // Replace the recorded fingerprint sha256 / file_count under
  // [package.metadata.font-fingerprint]. Preserve surrounding comments.
  out = out.replace(
    /(\[package\.metadata\.font-fingerprint\][\s\S]*?sha256\s*=\s*)"[^"]+"/m,
    `$1"${newSha}"`,
  );
  out = out.replace(
    /(\[package\.metadata\.font-fingerprint\][\s\S]*?file_count\s*=\s*)\d+/m,
    `$1${newCount}`,
  );
  return out;
}

async function populate() {
  if (!statSync(SRC_FONTS, { throwIfNoEntry: false })?.isDirectory()) {
    console.error(`sync-fonts: missing ${SRC_FONTS}. Run \`npm ci\` first.`);
    process.exit(1);
  }
  const dirs = Object.fromEntries(CRATES.map((c) => [c.key, join(c.dir, "fonts")]));
  for (const p of Object.values(dirs)) wipeDir(p);

  let counts = { core: 0, cjk: 0, cjkExtra: 0 };
  const families = readdirSync(SRC_FONTS)
    .filter((f) => statSync(join(SRC_FONTS, f)).isDirectory())
    .sort();

  for (const family of families) {
    const familyDir = join(SRC_FONTS, family);
    const shards = readdirSync(familyDir)
      .filter((f) => f.toLowerCase().endsWith(".woff2"))
      .sort();
    if (family !== "Xiaolai") {
      for (const shard of shards) {
        await convertShard(join(familyDir, shard), dirs.core, family);
        counts.core++;
      }
      continue;
    }
    for (const shard of shards) {
      const src = join(familyDir, shard);
      const bucket = dominantBucket(readFileSync(src));
      if (EXTRA_BUCKETS.has(bucket)) {
        await convertShard(src, dirs.cjkExtra, family);
        counts.cjkExtra++;
      } else {
        await convertShard(src, dirs.cjk, family);
        counts.cjk++;
      }
    }
  }
  console.log(`sync-fonts: ${counts.core} core, ${counts.cjk} cjk, ${counts.cjkExtra} cjk-extra`);
}

function maybeBump() {
  let bumped = 0;
  for (const c of CRATES) {
    const cargoPath = join(c.dir, "Cargo.toml");
    const fontsDir = join(c.dir, "fonts");
    const toml = readCargo(cargoPath);
    const recorded = readRecorded(toml);
    const computed = fingerprintFontsDir(fontsDir);
    if (
      recorded.fingerprint === computed.fingerprint &&
      recorded.count === computed.count
    ) {
      console.log(`sync-fonts --bump: ${c.key} unchanged (${computed.count} files)`);
      continue;
    }
    const oldVersion = readVersion(toml);
    const newVersion = bumpPatch(oldVersion);
    const next = rewriteCargo(toml, {
      newVersion,
      newSha: computed.fingerprint,
      newCount: computed.count,
    });
    writeFileSync(cargoPath, next);
    bumped++;
    console.log(
      `sync-fonts --bump: ${c.key} ${oldVersion} -> ${newVersion} ` +
      `(${recorded.count ?? "?"} -> ${computed.count} files, ` +
      `${(recorded.fingerprint ?? "").slice(0, 8)}.. -> ${computed.fingerprint.slice(0, 8)}..)`
    );
  }
  if (bumped > 0) {
    console.log(
      `sync-fonts --bump: ${bumped} crate(s) bumped. Review the diff and ` +
      `commit Cargo.toml changes.`,
    );
  }
}

async function main() {
  await populate();
  if (process.argv.includes("--bump")) maybeBump();
}

main();
