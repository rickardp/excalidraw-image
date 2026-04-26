// PNG-001 / PNG-002 — smoke tests for native PNG output.
//
// Spawns the release-profile binary against fixtures, writes PNG into the
// per-test tempdir, and asserts the bytes start with the PNG magic
// `89 50 4E 47 0D 0A 1A 0A`. Two fixtures cover the two main code paths:
//
//   * `basic-shapes.excalidraw` — geometry only, exercises resvg's path
//     rendering. Verifies the SVG → PNG pipeline (no fontdb dependency).
//   * `text-wrapped.excalidraw` — has `<text>` elements that resolve to
//     embedded WOFF2-decompressed-to-TTF fonts via fontdb. If the embedded
//     font table or fontdb wiring is broken, this test catches it.
//
// We do NOT pixel-compare here. Golden snapshots and SSIM live in PNG-003 /
// PNG-004 (deferred). Smoke = "does it run end-to-end and emit a PNG."

use std::path::PathBuf;
use std::process::Command;

const PNG_MAGIC: &[u8] = &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

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

/// Per-test output path. Co-locates files under cargo's target tmp dir so
/// concurrent test invocations don't clash and `cargo clean` reaps them.
fn out_path(name: &str) -> PathBuf {
    let tmp = std::env::temp_dir().join(format!("excalidraw-image-png-{}", std::process::id()));
    std::fs::create_dir_all(&tmp).expect("failed to create tmpdir");
    tmp.join(name)
}

#[test]
fn png_basic_shapes() {
    let bin = env!("CARGO_BIN_EXE_excalidraw-image");
    let fx = fixture("basic-shapes.excalidraw");
    let dst = out_path("basic-shapes.png");

    let out = Command::new(bin)
        .arg(&fx)
        .arg("-o")
        .arg(&dst)
        .output()
        .expect("failed to spawn excalidraw-image");
    assert!(
        out.status.success(),
        "binary exited with {:?}; stderr: {}",
        out.status.code(),
        String::from_utf8_lossy(&out.stderr),
    );

    let bytes = std::fs::read(&dst).expect("PNG output not written");
    assert!(
        bytes.starts_with(PNG_MAGIC),
        "first bytes {:02x?} do not match PNG magic",
        &bytes[..bytes.len().min(8)],
    );
    // Smoke threshold — anything smaller than this is suspicious for a
    // 420×140 RGBA PNG with non-trivial content.
    assert!(
        bytes.len() > 1024,
        "PNG suspiciously small: {} bytes",
        bytes.len(),
    );
}

#[test]
fn png_text_wrapped() {
    // text-wrapped exercises the fontdb path: usvg looks up "Virgil" /
    // "Excalifont" against the family list fontdb populates from the
    // build-time TTF blob. If the WOFF2-decompression step or the fontdb
    // load_font_data calls were ever to silently produce zero faces (the
    // bug that bit me during PNG-001 dev), this test would still produce
    // a PNG — but text would be missing. The size threshold below is the
    // only signal we have without pulling in a pixel-compare dep.
    let bin = env!("CARGO_BIN_EXE_excalidraw-image");
    let fx = fixture("text-wrapped.excalidraw");
    let dst = out_path("text-wrapped.png");

    let out = Command::new(bin)
        .arg(&fx)
        .arg("-o")
        .arg(&dst)
        .output()
        .expect("failed to spawn excalidraw-image");
    assert!(
        out.status.success(),
        "binary exited with {:?}; stderr: {}",
        out.status.code(),
        String::from_utf8_lossy(&out.stderr),
    );

    let bytes = std::fs::read(&dst).expect("PNG output not written");
    assert!(
        bytes.starts_with(PNG_MAGIC),
        "first bytes {:02x?} do not match PNG magic",
        &bytes[..bytes.len().min(8)],
    );
    // text-wrapped has visible text glyphs; a "boxes only, no text" output
    // is in the ~10 KB range, while glyph rendering pushes it well above
    // 30 KB. 20 KB is the safety margin.
    assert!(
        bytes.len() > 20_000,
        "PNG too small ({} bytes); fonts may not have rendered",
        bytes.len(),
    );
}

#[test]
fn png_format_flag_explicit() {
    // PNG-002: `--format png` must work even when output is stdout (no
    // extension hint). Pipes the PNG through stdout and asserts magic.
    let bin = env!("CARGO_BIN_EXE_excalidraw-image");
    let fx = fixture("basic-shapes.excalidraw");

    let out = Command::new(bin)
        .arg(&fx)
        .arg("--format")
        .arg("png")
        .output()
        .expect("failed to spawn excalidraw-image");
    assert!(
        out.status.success(),
        "binary exited with {:?}; stderr: {}",
        out.status.code(),
        String::from_utf8_lossy(&out.stderr),
    );
    assert!(
        out.stdout.starts_with(PNG_MAGIC),
        "stdout did not start with PNG magic; first bytes: {:02x?}",
        &out.stdout[..out.stdout.len().min(8)],
    );
}
