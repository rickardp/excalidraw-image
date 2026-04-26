//! Bundled font assets (Latin) for `excalidraw-image`. See README.md for the
//! contents list.
//!
//! Bytes are raw WOFF2; the consumer (`excalidraw-image`) decompresses to TTF
//! at its own build time via `woofwoof` for the fontdb, and ships the WOFF2
//! bytes themselves through the JS engine for Excalidraw's own subset path.
//!
//! This crate is not intended to be used standalone.

include!(concat!(env!("OUT_DIR"), "/fonts.rs"));
