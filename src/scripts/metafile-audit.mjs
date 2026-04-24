// src/scripts/metafile-audit.mjs — J-011
//
// CI gate for forbidden imports in dist/core.mjs. Reads dist/meta.json
// (produced by J-010's esbuild run) and fails if any input path matches
// one of the forbidden patterns in PLAN.md §5.7 step 4.
//
// These patterns are the signature of Excalidraw's React editor UI, i18n,
// and CSS — code paths that must be stubbed or tree-shaken out of the
// headless export bundle. A hit here means either tree-shaking regressed
// or an alias/plugin in build-core.mjs went stale.
//
// Skipping rule (F-001 / J-010 finding): keys prefixed with `stub-virtual:`
// are virtual paths created by the locales plugin; they must be skipped
// rather than flagged. Today those do not appear (the locales plugin
// redirects to a real on-disk stub), but future refactors may reintroduce
// them, so the skip is preventive.
//
// Scope: this script checks only the listed patterns. PLAN.md and TASKS.md
// are authoritative; do not add new rules here without updating both.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const META_PATH =
  process.env.METAFILE_AUDIT_PATH ?? path.join(repoRoot, "dist/meta.json");

// Forbidden patterns — PLAN.md §5.7 step 4, TASKS.md J-011 acceptance.
// Minimatch-style: `**` matches any sequence of path segments (including
// zero), `*` matches within a single segment.
//
// Do NOT extend this list without updating PLAN.md §5.7 step 4 first.
const FORBIDDEN_PATTERNS = [
  "**/components/App.tsx",
  "**/components/LayerUI.tsx",
  "**/actions/**",
  "**/hooks/**",
  "**/i18n.ts",
  "**/locales/**",
  "**/css/**",
];

// Tiny inline glob-to-regex: supports `**` (any segments) and `*`
// (single-segment). Enough for the patterns above; avoids pulling in
// minimatch as a devDependency for a 7-pattern gate.
function globToRegex(glob) {
  let re = "^";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      // `**/` → zero or more path segments. `**` alone → anything.
      if (glob[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 3;
      } else {
        re += ".*";
        i += 2;
      }
    } else if (c === "*") {
      re += "[^/]*";
      i += 1;
    } else if (/[.+^$(){}|\\]/.test(c)) {
      re += "\\" + c;
      i += 1;
    } else if (c === "?") {
      re += "[^/]";
      i += 1;
    } else {
      re += c;
      i += 1;
    }
  }
  re += "$";
  return new RegExp(re);
}

const FORBIDDEN_REGEXES = FORBIDDEN_PATTERNS.map((p) => ({
  pattern: p,
  regex: globToRegex(p),
}));

let meta;
try {
  meta = JSON.parse(readFileSync(META_PATH, "utf8"));
} catch (err) {
  if (err.code === "ENOENT") {
    process.stderr.write(
      "error: dist/meta.json not found — run 'make core' first\n",
    );
    process.exit(1);
  }
  throw err;
}

const inputs = meta.inputs ?? {};
const keys = Object.keys(inputs);

const offenders = [];
let scanned = 0;
for (const key of keys) {
  // F-001 / J-010: virtual plugin paths for locales. Skip, do not flag.
  if (key.startsWith("stub-virtual:")) continue;
  scanned += 1;
  for (const { pattern, regex } of FORBIDDEN_REGEXES) {
    if (regex.test(key)) {
      offenders.push({ key, pattern });
      break;
    }
  }
}

if (offenders.length > 0) {
  for (const { key } of offenders) {
    process.stderr.write(`${key}\n`);
  }
  process.stderr.write(
    `metafile-audit: ${offenders.length} forbidden paths in bundle\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `metafile-audit: ${scanned} inputs, 0 forbidden\n`,
);
process.exit(0);
