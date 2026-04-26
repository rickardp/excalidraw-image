# excalidraw-image-fonts-core

Bundled Latin-script font assets for [`excalidraw-image`](https://crates.io/crates/excalidraw-image).

Not intended to be used standalone. The main `excalidraw-image` crate depends on this crate to source raw WOFF2 bytes for the Excalidraw export pipeline + the resvg PNG rasterizer's font database.

## Contents

25 WOFF2 files across 8 families:

| Family | Files |
|---|---:|
| Assistant | 4 |
| Cascadia | 1 |
| ComicShanns | 4 |
| Excalifont | 7 |
| Liberation | 1 |
| Lilita | 2 |
| Nunito | 5 |
| Virgil | 1 |

Source: `node_modules/@excalidraw/excalidraw/dist/prod/fonts/`. CJK shards ship in the sibling crate `excalidraw-image-fonts-cjk`.

## Versioning

This crate is **versioned independently** from the main `excalidraw-image` crate. It is republished only when the WOFF2 contents change, verified by `npm run check:fonts` against `[package.metadata.font-fingerprint]` in `Cargo.toml`. Most main-crate releases reuse the existing version of this sub-crate.

## License

MIT. See `LICENSE`. Bundled WOFF2 assets are redistributed under their respective upstream licenses (see [`@excalidraw/excalidraw`](https://github.com/excalidraw/excalidraw) for details).
