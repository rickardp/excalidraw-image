// R-005 — build-time asset pipeline for `excalidraw-image`.
//
// Copies `dist/core.mjs` (produced by `make core` → J-010) into `OUT_DIR` so
// `src/engine.rs` can `include_str!(concat!(env!("OUT_DIR"), "/core.mjs"))`
// without an absolute path.
//
// Preference order:
//   1. `<repo-root>/dist/core.mjs` — the freshly-built local bundle. Used
//      during normal development and CI.
//   2. `crates/excalidraw-image/assets/core.mjs` — a committed mirror for
//      `cargo publish`. Populated by a release-prep script (not yet wired;
//      see PLAN §5.9). Left empty in v1 local builds.
//
// If neither is present, build fails with a clear message pointing at
// `make core`.
//
// Font-assets embedding and the generated `embedded_fonts.rs` mentioned in
// R-005's acceptance criteria are deferred: Phase 7 (PNG via resvg) is the
// only consumer of `EMBEDDED_FONTS`, and R-001 deliberately keeps the Phase
// 6 crate minimal. A follow-up task will extend this build script.

use std::env;
use std::fs;
use std::path::PathBuf;

fn main() {
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    // crates/excalidraw-image → crates → repo root
    let repo_root = manifest
        .parent()
        .expect("CARGO_MANIFEST_DIR has no parent")
        .parent()
        .expect("CARGO_MANIFEST_DIR grandparent missing");

    let dist_core = repo_root.join("dist").join("core.mjs");
    let assets_core = manifest.join("assets").join("core.mjs");

    let src = if dist_core.exists() {
        dist_core
    } else if assets_core.exists() {
        assets_core
    } else {
        panic!(
            "core.mjs not found. Run `make core` first, or check \
             crates/excalidraw-image/assets/core.mjs for a crates.io-friendly copy."
        );
    };

    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());
    let dest = out_dir.join("core.mjs");
    fs::copy(&src, &dest).expect("failed to copy core.mjs into OUT_DIR");

    println!("cargo:rerun-if-changed={}", src.display());
    println!("cargo:rerun-if-changed=build.rs");
}
