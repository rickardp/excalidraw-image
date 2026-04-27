// Reverse / round-trip integration tests.
//
// Exercises the symmetric CLI:
//   .excalidraw         → .excalidraw.svg → .excalidraw   (SVG round-trip)
//   .excalidraw         → .excalidraw.png → .excalidraw   (PNG round-trip)
//   plain .svg / .png   →  rejected with an error         (no embedded scene)
//
// These tests run the release binary and parse JSON to compare the
// extracted scene against the original. A literal byte-for-byte equality
// check would be too strict because the SVG path runs the scene through
// Excalidraw's own renderer (which fills in `appState` defaults and
// rewrites `source`); structural equality on `elements` / `files` /
// `type` is what actually matters for round-trip safety.

use std::path::PathBuf;
use std::process::Command;

fn bin() -> &'static str {
    env!("CARGO_BIN_EXE_excalidraw-image")
}

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

fn tmpdir() -> PathBuf {
    let p = std::env::temp_dir().join(format!(
        "excalidraw-image-rt-{}-{}",
        std::process::id(),
        rand_suffix()
    ));
    std::fs::create_dir_all(&p).expect("create tmpdir");
    p
}

fn rand_suffix() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos() as u64
}

fn run(args: &[&std::ffi::OsStr]) -> (bool, String, String) {
    let out = Command::new(bin())
        .args(args)
        .output()
        .expect("spawn failed");
    (
        out.status.success(),
        String::from_utf8_lossy(&out.stdout).to_string(),
        String::from_utf8_lossy(&out.stderr).to_string(),
    )
}

#[test]
fn svg_round_trip_preserves_elements() {
    let dir = tmpdir();
    let svg = dir.join("scene.excalidraw.svg");
    let extracted = dir.join("scene.excalidraw");
    let fx = fixture("basic-shapes.excalidraw");

    // Forward — .excalidraw.svg is editable by default.
    let (ok, _, err) = run(&[fx.as_ref(), "-o".as_ref(), svg.as_ref()]);
    assert!(ok, "forward render failed: {err}");

    // Reverse — pull the .excalidraw out.
    let (ok, _, err) = run(&[svg.as_ref(), "-o".as_ref(), extracted.as_ref()]);
    assert!(ok, "reverse extract failed: {err}");

    let original: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&fx).unwrap()).unwrap();
    let after: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&extracted).unwrap()).unwrap();

    assert_eq!(after["type"], original["type"]);
    assert_eq!(after["version"], original["version"]);
    assert_eq!(after["files"], original["files"]);

    // Element count + ids preserved (Excalidraw may rewrite some fields like
    // `boundElements: null` → `[]`; structural comparison covers identity).
    let orig_ids: Vec<&serde_json::Value> = original["elements"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| &e["id"])
        .collect();
    let after_ids: Vec<&serde_json::Value> = after["elements"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| &e["id"])
        .collect();
    assert_eq!(after_ids, orig_ids);
}

#[test]
fn png_round_trip_is_byte_exact() {
    // PNG embedding stuffs the *original* scene JSON into the tEXt chunk
    // (bypassing Excalidraw's renderer normalization), so reverse should
    // give back literally the input bytes.
    let dir = tmpdir();
    let png = dir.join("scene.excalidraw.png");
    let extracted = dir.join("scene.excalidraw");
    let fx = fixture("basic-shapes.excalidraw");

    let (ok, _, err) = run(&[fx.as_ref(), "-o".as_ref(), png.as_ref()]);
    assert!(ok, "forward render failed: {err}");

    let (ok, _, err) = run(&[png.as_ref(), "-o".as_ref(), extracted.as_ref()]);
    assert!(ok, "reverse extract failed: {err}");

    let original = std::fs::read(&fx).unwrap();
    let after = std::fs::read(&extracted).unwrap();
    assert_eq!(after, original, "PNG embed/extract should be byte-exact");
}

#[test]
fn plain_svg_output_has_no_scene_marker() {
    let dir = tmpdir();
    let svg = dir.join("plain.svg");
    let fx = fixture("basic-shapes.excalidraw");

    let (ok, _, err) = run(&[fx.as_ref(), "-o".as_ref(), svg.as_ref()]);
    assert!(ok, "forward render failed: {err}");

    let body = std::fs::read_to_string(&svg).unwrap();
    assert!(
        !body.contains("payload-type:application/vnd.excalidraw+json"),
        "plain .svg should not embed scene metadata"
    );
}

#[test]
fn extract_from_plain_svg_errors_clearly() {
    let dir = tmpdir();
    let svg = dir.join("plain.svg");
    let target = dir.join("nope.excalidraw");
    let fx = fixture("basic-shapes.excalidraw");

    // Render a plain SVG (no scene).
    let (ok, _, err) = run(&[fx.as_ref(), "-o".as_ref(), svg.as_ref()]);
    assert!(ok, "forward render failed: {err}");

    // Reverse should fail with a useful message — exit 1, not 0.
    let out = Command::new(bin())
        .arg(&svg)
        .arg("-o")
        .arg(&target)
        .output()
        .expect("spawn failed");
    assert_eq!(
        out.status.code(),
        Some(1),
        "expected runtime error (exit 1), got {:?}; stderr: {}",
        out.status.code(),
        String::from_utf8_lossy(&out.stderr)
    );
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        stderr.contains("does not contain"),
        "stderr should explain the missing scene; got: {stderr}"
    );
}

#[test]
fn editable_flag_overrides_plain_extension() {
    let dir = tmpdir();
    let svg = dir.join("plain.svg");
    let fx = fixture("basic-shapes.excalidraw");

    let (ok, _, err) = run(&[
        fx.as_ref(),
        "--editable".as_ref(),
        "-o".as_ref(),
        svg.as_ref(),
    ]);
    assert!(ok, "forward render failed: {err}");

    let body = std::fs::read_to_string(&svg).unwrap();
    assert!(
        body.contains("payload-type:application/vnd.excalidraw+json"),
        "--editable should add the embedded scene even with plain .svg ext"
    );
}
