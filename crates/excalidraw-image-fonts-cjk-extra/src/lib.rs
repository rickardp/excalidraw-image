//! Bundled CJK *extras* (Xiaolai shards covering CJK Extension A, CJK Compat
//! Ideographs, and other long-tail CJK ranges) for `excalidraw-image`. See
//! README.md for the contents list.
//!
//! Bytes are brotli-compressed TTF. The consumer (`excalidraw-image`)
//! decompresses at build time for the fontdb (resvg) and at runtime for the
//! JS engine (Excalidraw's own font subsetting path).
//!
//! Exists separately from `excalidraw-image-fonts-cjk` so the common-CJK
//! crate (modern Chinese, Japanese kanji, Korean Hangul) can stay under
//! crates.io's per-tarball size cap. Pulled in only when the main
//! `excalidraw-image` crate is built with the `cjk-full` feature.
//!
//! This crate is not intended to be used standalone.

include!(concat!(env!("OUT_DIR"), "/fonts.rs"));
