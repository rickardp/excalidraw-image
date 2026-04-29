//! Bundled CJK font assets (Xiaolai shards) for `excalidraw-image`. See
//! README.md for the contents list.
//!
//! Bytes are brotli-compressed TTF. The consumer (`excalidraw-image`)
//! decompresses at build time for the fontdb (resvg) and at runtime for the
//! JS engine (Excalidraw's own font subsetting path).
//!
//! This crate is not intended to be used standalone.

include!(concat!(env!("OUT_DIR"), "/fonts.rs"));
