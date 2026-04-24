// src/core/text-metrics.mjs — FontkitTextMetricsProvider + parseFontString.
//
// Host-neutral metrics provider backed by fontkit. Excalidraw's text path
// formats font strings as "<size>px <family-list>" via
// @excalidraw/common/src/utils.ts:110's `getFontString`. `getLineWidth`
// parses the size and first family, loads the matching bundled WOFF2 from
// `font-assets.mjs`, and measures the run via fontkit's `layout`.
//
// Host-neutrality notes (see PLAN.md §4.2 "portability contract" and
// eslint.config.js):
//   - No `Buffer`, no `node:*`, no filesystem.
//   - fontkit 2.0.4's `create()` feeds its argument straight into a
//     restructure `DecodeStream`, which only reads `.buffer`, `.byteOffset`,
//     `.byteLength`, and `.length`. A `Uint8Array` satisfies all four, so
//     we hand it a plain Uint8Array — no Buffer import, no shim. Verified
//     against node_modules/restructure/src/DecodeStream.js.
//   - `atob` is provided by the J-002 web-globals shim at runtime and by
//     the host (Node/Deno) during unit tests.
//
// Shard selection (minimal):
//   FONT_ASSETS[family] is an array of WOFF2 shards split by unicode-range.
//   Full range-aware selection lands in FNT-009; for T-001 we probe the
//   shards with `hasGlyphForCodePoint` at query time and pick the first
//   shard that covers the text. This gives real Latin metrics for "Hello"
//   even though the family's shard[0] may be a symbols-only subset.
//
// Minimal fallback policy (full policy lands in FNT-009):
//   Helvetica → Liberation (PLAN §4A.5). Any other unknown family →
//   Excalifont. If Excalifont itself is missing (no fonts loaded at all),
//   return the degenerate `text.length * 8` so callers never throw.

import * as fontkit from "fontkit";
import { FONT_ASSETS } from "./font-assets.mjs";

// One-line alias map for T-001 scope. FNT-009 will expand this + add
// strict-mode handling for unknown families.
const FAMILY_ALIASES = Object.freeze({
  Helvetica: "Liberation",
});

const FALLBACK_FAMILY = "Excalifont";

/**
 * Parse a CSS-style font string of the form "<size>px <family-list>" into
 * `{ pxSize, family }` where `family` is the first family name with
 * surrounding quotes stripped.
 *
 * Examples:
 *   "20px Virgil, Segoe UI Emoji"     -> { pxSize: 20,   family: "Virgil" }
 *   "14.5px Excalifont"               -> { pxSize: 14.5, family: "Excalifont" }
 *   "16px 'Comic Shanns'"             -> { pxSize: 16,   family: "Comic Shanns" }
 *   '20px "Lilita One"'               -> { pxSize: 20,   family: "Lilita One" }
 */
export function parseFontString(fontString) {
  if (typeof fontString !== "string") {
    throw new TypeError(`parseFontString: expected string, got ${typeof fontString}`);
  }
  const trimmed = fontString.trim();
  // Capture: numeric size (int or fractional) + "px" + rest (family list).
  const match = trimmed.match(/^([0-9]+(?:\.[0-9]+)?)px\s+(.+)$/);
  if (!match) {
    throw new Error(`parseFontString: cannot parse font string ${JSON.stringify(fontString)}`);
  }
  const pxSize = Number(match[1]);
  // First family = everything up to the first comma that is NOT inside quotes.
  // For our inputs (Excalidraw's getFontString output), family names never
  // contain commas, so a simple split-on-comma is sufficient.
  const rawFirst = match[2].split(",")[0].trim();
  const family = _stripQuotes(rawFirst);
  return { pxSize, family };
}

function _stripQuotes(s) {
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === '"' || first === "'") && first === last) {
      return s.slice(1, -1).trim();
    }
  }
  return s;
}

function _base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

export class FontkitTextMetricsProvider {
  constructor() {
    // family → fontkit.Font[] (all loaded shards, same order as FONT_ASSETS)
    this._fontCache = new Map();
    this._fallbackFamily = FALLBACK_FAMILY;
  }

  getLineWidth(text, fontString) {
    if (text === "" || text == null) {
      return 0;
    }
    const { pxSize, family } = parseFontString(fontString);
    const resolved = FAMILY_ALIASES[family] ?? family;
    const font =
      this._getFontForText(resolved, text) ||
      this._getFontForText(this._fallbackFamily, text);
    if (!font) {
      // Degenerate path: no fonts loaded at all. Match the J-005 placeholder
      // so callers relying on non-zero widths still work.
      return text.length * 8;
    }
    const run = font.layout(text);
    const emScale = pxSize / font.unitsPerEm;
    return run.positions.reduce((sum, p) => sum + p.xAdvance * emScale, 0);
  }

  // Pick the first shard that covers every codepoint in `text`. Falls back
  // to the first shard if no shard has full coverage — that matches the
  // task's "use the first shard for now" guidance while still giving real
  // metrics for Latin when a Latin-covering shard exists.
  //
  // TODO(FNT-009): replace this glyph-probe with proper unicode-range
  // matching + per-codepoint shard mixing.
  _getFontForText(family, text) {
    const fonts = this._loadAllShards(family);
    if (fonts === null || fonts.length === 0) {
      return null;
    }
    for (const font of fonts) {
      if (_fontCoversText(font, text)) {
        return font;
      }
    }
    return fonts[0];
  }

  _loadAllShards(family) {
    if (this._fontCache.has(family)) {
      return this._fontCache.get(family);
    }
    const entries = FONT_ASSETS[family];
    if (!entries || entries.length === 0) {
      this._fontCache.set(family, null);
      return null;
    }
    const fonts = entries.map((entry) => {
      const bytes = _base64ToBytes(entry.base64);
      // fontkit.create accepts any object with { buffer, byteOffset,
      // byteLength, length } — Uint8Array qualifies, no Buffer needed.
      return fontkit.create(bytes);
    });
    this._fontCache.set(family, fonts);
    return fonts;
  }
}

function _fontCoversText(font, text) {
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (!font.hasGlyphForCodePoint(cp)) {
      return false;
    }
  }
  return true;
}

// Shared lazy singleton. Consumers (canvas shim T-003, Excalidraw provider
// registration T-004) must obtain the same instance so font caches and any
// future per-provider state remain coherent. Instantiated on first access —
// lazy construction avoids pulling fontkit into module-eval order when only
// the parser is imported.
let _shared = null;
export function getSharedTextMetricsProvider() {
  if (_shared === null) _shared = new FontkitTextMetricsProvider();
  return _shared;
}
