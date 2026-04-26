# excalidraw-image-fonts-cjk

CJK font shards (Xiaolai) for [`excalidraw-image`](https://crates.io/crates/excalidraw-image).

Not intended to be used standalone. Pulled in only when the main `excalidraw-image` crate is built with the `cjk` feature:

```
cargo install excalidraw-image --features cjk
```

Without this feature, `excalidraw-image` ships ~12 MB lighter and CJK glyphs render as tofu unless the viewer's environment supplies them.

## Contents

209 WOFF2 shards split by Unicode range, all under the `Xiaolai/` family directory. Source: `node_modules/@excalidraw/excalidraw/dist/prod/fonts/`.

## Versioning

This crate is **versioned independently** from the main `excalidraw-image` crate. It is republished only when the WOFF2 contents change, verified by `npm run check:fonts` against `[package.metadata.font-fingerprint]` in `Cargo.toml`.

## License

MIT. See `LICENSE`. Bundled WOFF2 assets are redistributed under their respective upstream licenses (see [`@excalidraw/excalidraw`](https://github.com/excalidraw/excalidraw) for details).
