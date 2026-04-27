// R-006 — single-fixture smoke test for the `excalidraw-image` binary.
//
// Spawns the release-profile binary against `tests/fixtures/basic-shapes.excalidraw`
// and asserts the minimum contract: exit zero, SVG prolog, some shape output,
// no literal `undefined` in the stream (a classic JS-stringify-gone-wrong
// tell).
//
// Intentionally narrow: this is a "does the wiring work end-to-end" gate, not
// a rendering correctness gate. Rendering parity is covered by `parity.rs`.
//
// Location: `crates/excalidraw-image/tests/smoke.rs`, not the repo-level
// `tests/rust/` directory — cargo integration tests must live inside the
// owning crate. the implementation notes `tests/rust/` is retained as the home for
// non-crate-owned harness files (e.g. `deno-run.mjs`).

use std::path::PathBuf;
use std::process::Command;

/// Absolute path to a fixture in the repo-level `tests/fixtures/` dir. Cargo
/// gives us `CARGO_MANIFEST_DIR = <repo>/crates/excalidraw-image`; going up
/// two levels lands at the repo root.
fn fixture(name: &str) -> PathBuf {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest
        .parent()
        .and_then(|p| p.parent())
        .expect("CARGO_MANIFEST_DIR has no grandparent")
        .join("tests")
        .join("fixtures")
        .join(name)
}

#[test]
fn smoke_basic_shapes() {
    let bin = env!("CARGO_BIN_EXE_excalidraw-image");
    let fx = fixture("basic-shapes.excalidraw");
    let out = Command::new(bin)
        .arg(&fx)
        .output()
        .expect("failed to spawn excalidraw-image");

    assert!(
        out.status.success(),
        "binary exited with {:?}; stderr: {}",
        out.status.code(),
        String::from_utf8_lossy(&out.stderr),
    );

    let svg = String::from_utf8_lossy(&out.stdout);

    // Minimum shape assertions. The basic-shapes fixture has a rectangle +
    // arrow; the arrow renders as `<path>`, the rectangle as `<rect>` or
    // (in handdrawn mode) as paths.
    assert!(svg.starts_with("<svg"), "stdout did not start with <svg: {:?}", &svg[..svg.len().min(80)]);
    assert!(
        svg.contains("<rect") || svg.contains("<path"),
        "expected <rect> or <path> in output; got prefix: {:?}",
        &svg[..svg.len().min(200)],
    );
    assert!(
        !svg.contains("undefined"),
        "literal 'undefined' in SVG output — likely a JS stringify bug",
    );
}
