// R-008 — error-handling gate.
//
// Verifies the exit-code policy from the implementation notes / the original task board R-008:
//   * missing input file → exit 1, stderr names the path.
//   * unknown flag        → exit 2, stderr mentions `--help`.
//   * invalid scene JSON  → exit 1, stderr starts with `error:`.
//   * JS-thrown error     → exit 1, stderr carries the JS message.
//
// These are black-box tests against the built binary; no in-process harness.
// They catch regressions where a future error-reporting refactor silently
// drops exit-code fidelity or swallows messages.

use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

fn bin() -> &'static str {
    env!("CARGO_BIN_EXE_excalidraw-image")
}

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .unwrap()
        .to_path_buf()
}

#[test]
fn missing_file_exits_one_with_path_in_stderr() {
    let ghost = "/tmp/this-path-does-not-exist-excalidraw-image-xyz.excalidraw";
    let out = Command::new(bin()).arg(ghost).output().unwrap();
    assert_eq!(out.status.code(), Some(1), "stderr: {}", String::from_utf8_lossy(&out.stderr));
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(
        err.contains(ghost),
        "stderr should mention the missing path. got: {err}"
    );
}

#[test]
fn unknown_flag_exits_two_and_suggests_help() {
    let out = Command::new(bin()).arg("--definitely-not-a-flag").output().unwrap();
    assert_eq!(
        out.status.code(),
        Some(2),
        "unknown flag should exit 2; stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(
        err.contains("--help") || err.to_lowercase().contains("usage"),
        "stderr should point at --help / Usage. got: {err}"
    );
}

#[test]
fn broken_json_exits_one_with_error_prefix() {
    // Feed clearly-invalid JSON via stdin. The JS side's JSON.parse will
    // throw; the engine surfaces that as an error. Exit code = 1.
    let mut child = Command::new(bin())
        .arg("-")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn");
    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(b"{ not valid json at all")
        .unwrap();
    let out = child.wait_with_output().unwrap();
    assert_eq!(
        out.status.code(),
        Some(1),
        "broken JSON should exit 1; stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(
        err.starts_with("error:"),
        "stderr should start with `error:`. got: {err}"
    );
}

#[test]
fn js_side_error_surfaces_message_on_exit_one() {
    // A valid JSON document but with a shape the Excalidraw export path
    // can't handle: `elements` is not an array. This reaches the JS side
    // and throws from within exportToSvg. We assert exit=1 and that the
    // JS error class/message makes it to stderr (R-008: not just
    // `Error: undefined`).
    let mut child = Command::new(bin())
        .arg("-")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn");
    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(br#"{"type":"excalidraw","version":2,"source":"x","elements":"not-an-array","appState":{},"files":{}}"#)
        .unwrap();
    let out = child.wait_with_output().unwrap();
    assert_eq!(
        out.status.code(),
        Some(1),
        "JS error should exit 1; stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(
        err.starts_with("error:"),
        "stderr should start with `error:`. got: {err}"
    );
    // The message should be informative — not the literal `Error: undefined`
    // mentioned in R-008. We accept any non-trivial stderr body.
    assert!(
        !err.trim().eq_ignore_ascii_case("error: undefined"),
        "stderr was just `error: undefined`, violating R-008: {err}"
    );
    // Sanity — `_` isn't taken from the repo root, this just keeps the helper
    // compiled & honest if other tests grow later.
    let _root = repo_root();
}
