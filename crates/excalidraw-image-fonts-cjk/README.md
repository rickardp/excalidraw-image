# excalidraw-image-fonts-cjk

Common CJK font shards (Xiaolai) for [`excalidraw-image`](https://crates.io/crates/excalidraw-image).

Not intended to be used standalone. Pulled in only when the main `excalidraw-image` crate is built with the `cjk` feature:

```
cargo install excalidraw-image --features cjk
```

Covers modern Chinese, Japanese kanji, Korean Hangul Syllables, and common CJK punctuation/compatibility ranges. For long-tail coverage (CJK Extension A, Compat Ideographs, Radicals, Hangul Jamo) install with `--features cjk-full`, which pulls in the [`excalidraw-image-fonts-cjk-extra`](https://crates.io/crates/excalidraw-image-fonts-cjk-extra) sister crate on top.

Without any CJK feature, `excalidraw-image` ships ~9 MB lighter and CJK glyphs render as tofu unless the viewer's environment supplies them.

## Contents

165 WOFF2 shards covering:

- **CJK Unified Ideographs** (U+4E00–U+9FFF) — modern Chinese + Japanese kanji
- **Hangul Syllables** (U+AC00–U+D7AF) — modern Korean
- CJK Symbols & Punctuation, Hiragana, Katakana, Bopomofo, Hangul Compat Jamo, Halfwidth/Fullwidth, and other commonly-hit blocks

All under the `Xiaolai/` family directory. Source: `node_modules/@excalidraw/excalidraw/dist/prod/fonts/`.

## Versioning

This crate is **versioned independently** from the main `excalidraw-image` crate. It is republished only when the WOFF2 contents change, verified by `npm run check:fonts` against `[package.metadata.font-fingerprint]` in `Cargo.toml`.

## License

MIT. See `LICENSE`. Bundled WOFF2 assets are redistributed under their respective upstream licenses (see [`@excalidraw/excalidraw`](https://github.com/excalidraw/excalidraw) for details).
