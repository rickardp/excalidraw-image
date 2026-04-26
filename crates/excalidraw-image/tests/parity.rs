// R-007 — Deno-vs-Rust byte-identity parity gate (PLAN §8.2).
//
// For every fixture in `tests/fixtures/*.excalidraw`:
//   1. spawn the release-profile `excalidraw-image` binary;
//   2. spawn `deno run --allow-read tests/rust/deno-run.mjs <fixture>`;
//   3. assert `stdout_rust == stdout_deno` byte-for-byte.
//
// Any divergence here is a host leak: something in the JS bundle reads a
// runtime-specific value (locale, timezone, `Math.random` without a seeded
// path, `performance.now` timing). The fix is always on the JS side — per
// PLAN §12 ("parity gate ... is the migration-safety gate") and TASKS.md
// appendix ("Do not skip the parity gate by special-casing either host. If
// Deno and Rust disagree, fix the JS, not the test").
//
// When a fixture fails, both outputs are dumped under `/tmp/parity-*.svg`
// for side-by-side diffing. The test harness then `panic!`s with fixture
// name + byte counts so CI logs make the regression obvious.
//
// **Requires the `cjk` feature.** The Deno driver loads every WOFF2 from
// `node_modules/.../fonts/` (including Xiaolai's 209 CJK shards), so for
// byte-identical output the Rust side must also have CJK fonts compiled
// in. `make parity` invokes us with `--features cjk`. `cargo test`
// without features skips this whole module silently.

#![cfg(feature = "cjk")]

use std::path::PathBuf;
use std::process::Command;

fn repo_root() -> PathBuf {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest
        .parent()
        .and_then(|p| p.parent())
        .expect("CARGO_MANIFEST_DIR has no grandparent")
        .to_path_buf()
}

fn fixtures_dir() -> PathBuf {
    repo_root().join("tests").join("fixtures")
}

fn deno_driver() -> PathBuf {
    repo_root().join("tests").join("rust").join("deno-run.mjs")
}

#[test]
fn parity_all_fixtures() {
    let bin = env!("CARGO_BIN_EXE_excalidraw-image");
    let driver = deno_driver();
    assert!(
        driver.exists(),
        "deno driver missing: {}",
        driver.display()
    );

    let mut fixtures: Vec<PathBuf> = std::fs::read_dir(fixtures_dir())
        .expect("failed to read tests/fixtures/")
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().map_or(false, |x| x == "excalidraw"))
        .collect();
    fixtures.sort();
    assert!(!fixtures.is_empty(), "no fixtures found under tests/fixtures/");

    let mut failures: Vec<String> = Vec::new();

    for fixture in &fixtures {
        let rust_out = Command::new(bin)
            .arg(fixture)
            .output()
            .expect("failed to spawn excalidraw-image");
        if !rust_out.status.success() {
            failures.push(format!(
                "{}: rust binary failed ({:?}): {}",
                fixture.display(),
                rust_out.status.code(),
                String::from_utf8_lossy(&rust_out.stderr)
            ));
            continue;
        }

        let deno_out = Command::new("deno")
            .args(["run", "--allow-read"])
            .arg(&driver)
            .arg(fixture)
            .output()
            .expect("failed to spawn deno (is it on PATH?)");
        if !deno_out.status.success() {
            failures.push(format!(
                "{}: deno driver failed ({:?}): {}",
                fixture.display(),
                deno_out.status.code(),
                String::from_utf8_lossy(&deno_out.stderr)
            ));
            continue;
        }

        if rust_out.stdout != deno_out.stdout {
            let stem = fixture
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| "unknown".to_string());
            let rust_path = format!("/tmp/parity-rust-{stem}.svg");
            let deno_path = format!("/tmp/parity-deno-{stem}.svg");
            let _ = std::fs::write(&rust_path, &rust_out.stdout);
            let _ = std::fs::write(&deno_path, &deno_out.stdout);
            failures.push(format!(
                "{}: PARITY FAIL — rust={} bytes, deno={} bytes. See {} and {}",
                fixture.display(),
                rust_out.stdout.len(),
                deno_out.stdout.len(),
                rust_path,
                deno_path,
            ));
        }
    }

    if !failures.is_empty() {
        panic!(
            "parity gate failed on {}/{} fixture(s):\n  {}",
            failures.len(),
            fixtures.len(),
            failures.join("\n  ")
        );
    }
}
