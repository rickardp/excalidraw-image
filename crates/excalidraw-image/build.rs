// R-005 / PNG-001 — build-time asset pipeline for `excalidraw-image`.
//
// Three outputs land in `OUT_DIR`:
//
//   1. `core.mjs` — copied from `<repo-root>/dist/core.mjs` (produced by
//      `make core` → J-010), or the committed mirror at
//      `crates/excalidraw-image/assets/core.mjs` for `cargo publish`. Loaded
//      via `include_str!` from `src/engine.rs`.
//   2. `embedded_fonts.bin` — a single concatenated blob of all decompressed
//      TTF font bytes.
//   3. `embedded_fonts.rs` — a generated source file declaring
//      `pub static EMBEDDED_FONTS_BLOB: &[u8]` (from `include_bytes!` on
//      `embedded_fonts.bin`) and `pub static EMBEDDED_FONTS: &[(&str, &[u8])]`
//      whose slice bodies are subranges of the blob (offset/length tuples
//      via `&BLOB[start..end]`). Loaded via `include!` from `src/raster.rs`.
//
// Embedding strategy: **Option Y** (offset/length tuples + single .bin via
// one `include_bytes!`). PNG-001's task spec preferred Option X
// (`include_bytes!` per absolute path), but fontdb (used by usvg/resvg)
// only consumes raw TTF/OTF — loading raw WOFF2 bytes silently produces
// zero faces (verified empirically). We must decompress WOFF2 → TTF at
// build time, which means writing the decompressed bytes to disk anyway.
// One concatenated .bin file keeps `include_bytes!` to a single call and
// matches the fallback Option Y described in the PNG-001 prompt.
//
// If `make core` hasn't run, or if the npm fonts dir is missing, the build
// fails with a clear message.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use walkdir::WalkDir;

fn main() {
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    // crates/excalidraw-image → crates → repo root
    let repo_root = manifest
        .parent()
        .expect("CARGO_MANIFEST_DIR has no parent")
        .parent()
        .expect("CARGO_MANIFEST_DIR grandparent missing");

    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());

    copy_core_mjs(repo_root, &manifest, &out_dir);
    emit_embedded_fonts(repo_root, &out_dir);

    println!("cargo:rerun-if-changed=build.rs");
}

fn copy_core_mjs(repo_root: &Path, manifest: &Path, out_dir: &Path) {
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

    let dest = out_dir.join("core.mjs");
    fs::copy(&src, &dest).expect("failed to copy core.mjs into OUT_DIR");

    println!("cargo:rerun-if-changed={}", src.display());
}

fn emit_embedded_fonts(repo_root: &Path, out_dir: &Path) {
    // npm-installed fonts. PNG-001 reads the same byte-for-byte assets the JS
    // side base64-embeds (FNT-002), so fontdb and Excalidraw's @font-face
    // declarations stay in lockstep.
    let fonts_dir = repo_root
        .join("node_modules")
        .join("@excalidraw")
        .join("excalidraw")
        .join("dist")
        .join("prod")
        .join("fonts");

    if !fonts_dir.exists() {
        panic!(
            "fonts dir not found at {}. Run `npm ci` to populate node_modules.",
            fonts_dir.display()
        );
    }

    let mut woff2_paths: Vec<PathBuf> = WalkDir::new(&fonts_dir)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .map(|e| e.into_path())
        .filter(|p| p.extension().and_then(|s| s.to_str()) == Some("woff2"))
        .collect();
    // Stable ordering so the generated blob and source diff cleanly across
    // builds (matches FNT-001 deterministic-ordering requirement).
    woff2_paths.sort();

    if woff2_paths.is_empty() {
        panic!(
            "no .woff2 files found under {}. Has @excalidraw/excalidraw been installed?",
            fonts_dir.display()
        );
    }

    // Decompress every WOFF2 → TTF, concatenate into a single blob, and
    // record (relative-path, offset, length) for each. fontdb won't accept
    // raw WOFF2; decompressing once at build time avoids runtime cost and
    // lets us keep one `include_bytes!` site.
    let mut blob: Vec<u8> = Vec::with_capacity(20 * 1024 * 1024);
    let mut entries: Vec<(String, usize, usize)> = Vec::with_capacity(woff2_paths.len());
    for path in &woff2_paths {
        let rel = path
            .strip_prefix(&fonts_dir)
            .expect("walked path is under fonts_dir")
            .to_string_lossy()
            .replace('\\', "/");
        let woff2_bytes = fs::read(path)
            .unwrap_or_else(|e| panic!("failed to read {}: {e}", path.display()));
        let ttf_bytes = woofwoof::decompress(&woff2_bytes)
            .unwrap_or_else(|| panic!("WOFF2 decompress failed for {}", path.display()));
        let start = blob.len();
        blob.extend_from_slice(&ttf_bytes);
        entries.push((rel, start, ttf_bytes.len()));
    }

    let bin_path = out_dir.join("embedded_fonts.bin");
    fs::write(&bin_path, &blob).expect("failed to write embedded_fonts.bin");

    // The generated table holds `(name, offset, length)` so it can live in a
    // `static` on stable Rust — slicing into a `&[u8]` is not yet `const`
    // (rust-lang/rust#143874). `raster::iter_embedded_fonts()` materializes
    // `(&str, &[u8])` pairs at runtime by indexing into the blob.
    let mut body = String::new();
    body.push_str(&format!(
        "// Generated by build.rs from {}. Do not edit.\n",
        fonts_dir.display(),
    ));
    body.push_str("pub static EMBEDDED_FONTS_BLOB: &[u8] = include_bytes!(\"embedded_fonts.bin\");\n");
    body.push_str("pub static EMBEDDED_FONT_INDEX: &[(&str, usize, usize)] = &[\n");
    for (rel, start, len) in &entries {
        body.push_str(&format!("    (\"{}\", {}, {}),\n", rel, start, len));
    }
    body.push_str("];\n");

    let dest = out_dir.join("embedded_fonts.rs");
    fs::write(&dest, body).expect("failed to write embedded_fonts.rs");

    // Re-run if any font is added/removed/changed.
    println!("cargo:rerun-if-changed={}", fonts_dir.display());
    for p in &woff2_paths {
        println!("cargo:rerun-if-changed={}", p.display());
    }
}
