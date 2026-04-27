// R-001 / PNG-001 — `excalidraw-image` library crate.
//
// Exposes the `argv`, `engine`, and `raster` modules so `main.rs` and
// integration tests can link against them. There is no additional façade
// API; this crate is primarily a CLI, and the library surface exists for
// testability.

pub mod argv;
pub mod embed;
pub mod engine;
pub mod extract;
pub mod raster;
