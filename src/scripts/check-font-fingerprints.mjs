#!/usr/bin/env node
// Verifies each font sub-crate's [package.metadata.font-fingerprint] sha256 +
// file_count match the actual contents of its fonts/ directory.
//
// Why: font sub-crates publish to crates.io independently from the main
// excalidraw-image crate. They should bump version (and republish) only when
// fonts actually change. This check prevents silent drift — if you change
// fonts but forget to bump version + update the recorded fingerprint, CI
// fails here before the release flow runs.
//
// Manual procedure when fonts change deliberately:
//   1. Replace WOFF2 files in crates/excalidraw-image-fonts-{core,cjk}/fonts/.
//   2. Run `npm run check:fonts` — it prints the new fingerprint+count.
//   3. Bump `version` in the sub-crate's Cargo.toml.
//   4. Update [package.metadata.font-fingerprint] sha256 and file_count to
//      the printed values.
//   5. Commit; push; the release flow republishes only that sub-crate.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative } from "node:path";

function walk(dir) {
  const out = [];
  function recurse(d) {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      const st = statSync(full);
      if (st.isDirectory()) recurse(full);
      else if (st.isFile() && name.toLowerCase().endsWith(".woff2")) out.push(full);
    }
  }
  recurse(dir);
  return out;
}

function hashCrate(cratePath) {
  const fontsDir = join(cratePath, "fonts");
  const files = walk(fontsDir).sort();
  const lines = files.map((p) => {
    const rel = relative(fontsDir, p).split("\\").join("/");
    const sha = createHash("sha256").update(readFileSync(p)).digest("hex");
    return `${rel}:${sha}`;
  });
  const fingerprint = createHash("sha256").update(lines.join("\n")).digest("hex");
  return { fingerprint, count: files.length };
}

function readRecorded(cratePath) {
  const tom = readFileSync(join(cratePath, "Cargo.toml"), "utf8");
  const block = tom.match(/\[package\.metadata\.font-fingerprint\]([\s\S]*?)(?=\n\[|$)/);
  if (!block) return { fingerprint: null, count: null };
  const sha = block[1].match(/sha256\s*=\s*"([^"]+)"/m)?.[1] ?? null;
  const count = parseInt(block[1].match(/file_count\s*=\s*(\d+)/m)?.[1] ?? "-1", 10);
  return { fingerprint: sha, count };
}

const crates = [
  "crates/excalidraw-image-fonts-core",
  "crates/excalidraw-image-fonts-cjk",
];

let ok = true;
for (const c of crates) {
  const computed = hashCrate(c);
  const recorded = readRecorded(c);
  if (computed.fingerprint !== recorded.fingerprint || computed.count !== recorded.count) {
    console.error(`FAIL ${c}`);
    console.error(`  recorded: ${recorded.fingerprint} (${recorded.count} files)`);
    console.error(`  computed: ${computed.fingerprint} (${computed.count} files)`);
    console.error(`  -> Bump 'version' in ${c}/Cargo.toml and update`);
    console.error(`     [package.metadata.font-fingerprint] sha256 + file_count to the`);
    console.error(`     computed values above.`);
    ok = false;
  } else {
    console.log(`OK ${c} (${recorded.count} files, ${recorded.fingerprint.slice(0, 12)}…)`);
  }
}
process.exit(ok ? 0 : 1);
