// R-001 — `excalidraw-image` library crate.
//
// Exposes the `argv` and `engine` modules so `main.rs` and integration
// tests can link against them. There is no additional façade API; this
// crate is primarily a CLI, and the library surface exists for testability.

pub mod argv;
pub mod engine;
