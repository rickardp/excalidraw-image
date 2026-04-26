# excalidraw-image-fonts-cjk-extra

Long-tail CJK font shards (Xiaolai) for [`excalidraw-image`](https://crates.io/crates/excalidraw-image).

Not intended to be used standalone. Pulled in only when the main `excalidraw-image` crate is built with the `cjk-full` feature:

```
cargo install excalidraw-image --features cjk-full
```

`cjk-full` implies `cjk`, so this crate sits on top of `excalidraw-image-fonts-cjk` rather than replacing it. Only enable it if your scenes contain CJK Extension A characters (classical Chinese, rare ideographs, scholarly texts, dialect-specific terms), CJK Compatibility Ideographs, CJK Radicals, or Hangul Jamo.

## Contents

44 WOFF2 shards covering:

- **CJK Extension A** (U+3400–U+4DBF) — historical/rare ideographs
- **CJK Compatibility Ideographs** (U+F900–U+FAFF)
- **CJK Radicals Supplement** (U+2E80–U+2EFF) and **Kangxi Radicals** (U+2F00–U+2FDF)
- **Hangul Jamo** (U+1100–U+11FF) — legacy decomposition forms

Source: `node_modules/@excalidraw/excalidraw/dist/prod/fonts/`.

## Versioning

This crate is **versioned independently** from the main `excalidraw-image` crate. It is republished only when the WOFF2 contents change, verified by `npm run check:fonts` against `[package.metadata.font-fingerprint]` in `Cargo.toml`.

## License

MIT. See `LICENSE`. Bundled WOFF2 assets are redistributed under their respective upstream licenses (see [`@excalidraw/excalidraw`](https://github.com/excalidraw/excalidraw) for details).
