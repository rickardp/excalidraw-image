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
    emit_embedded_fonts(&out_dir);
    let _ = repo_root; // unused once fonts come from sub-crates

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

    let bytes = fs::read(&src).expect("failed to read core.mjs");
    let dest = out_dir.join("core.mjs");
    fs::write(&dest, &bytes).expect("failed to write core.mjs into OUT_DIR");

    // Cache key for the runtime snapshot cache (engine.rs). CRC32 alone
    // is fine for a content-addressed local cache: collisions across
    // bundle revisions are vanishingly unlikely, and the crate version
    // is also folded into the filename so genuine upgrades invalidate.
    let crc = crc32fast::hash(&bytes);
    println!("cargo:rustc-env=EXCALIDRAW_IMAGE_CORE_CRC32={crc:08x}");

    println!("cargo:rerun-if-changed={}", src.display());
}

fn emit_embedded_fonts(out_dir: &Path) {
    // Source fonts from the sub-crates' static FONTS arrays. The bytes are
    // brotli-compressed TTF; we decompress here for fontdb (resvg) consumption.
    let mut fonts: Vec<(&'static str, &'static [u8])> = Vec::new();
    fonts.extend_from_slice(excalidraw_image_fonts_core::FONTS);
    #[cfg(feature = "cjk")]
    fonts.extend_from_slice(excalidraw_image_fonts_cjk::FONTS);
    #[cfg(feature = "cjk-full")]
    fonts.extend_from_slice(excalidraw_image_fonts_cjk_extra::FONTS);
    fonts.sort_by_key(|(p, _)| *p);

    if fonts.is_empty() {
        panic!("no fonts in excalidraw-image-fonts-core::FONTS — empty sub-crate?");
    }

    // Decompress every brotli-compressed TTF, concatenate into a single blob,
    // and record (relative-path, offset, length) for each.
    let mut blob: Vec<u8> = Vec::with_capacity(20 * 1024 * 1024);
    let mut entries: Vec<(String, usize, usize)> = Vec::with_capacity(fonts.len());

    for (path, compressed) in &fonts {
        let mut decoder = brotli::Decompressor::new(*compressed, 4096);
        let mut ttf_bytes = Vec::new();
        std::io::Read::read_to_end(&mut decoder, &mut ttf_bytes)
            .unwrap_or_else(|e| panic!("brotli decompress failed for {path}: {e}"));

        // TTF blob for fontdb/resvg
        let start = blob.len();
        blob.extend_from_slice(&ttf_bytes);
        entries.push((path.to_string(), start, ttf_bytes.len()));
    }

    // Write the fontdb (TTF) blob.
    let bin_path = out_dir.join("embedded_fonts.bin");
    fs::write(&bin_path, &blob).expect("failed to write embedded_fonts.bin");

    // Copy the pre-generated WOFF2 blob for the JS engine path.
    // Excalidraw's subsetter calls woff2Dec internally, so __embeddedFonts
    // must contain WOFF2 bytes. The blob is pre-encoded by
    // `node src/scripts/build-woff2-blob.mjs` using wawoff2 (the same WASM
    // encoder that Deno/vitest use), guaranteeing byte-identical parity.
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let js_blob_src = manifest.join("assets").join("embedded_fonts_js.bin");
    let js_index_src = manifest.join("assets").join("embedded_fonts_js.json");
    if !js_blob_src.exists() || !js_index_src.exists() {
        panic!(
            "embedded_fonts_js.{{bin,json}} not found in assets/. \
             Run `node src/scripts/build-woff2-blob.mjs` first."
        );
    }

    // Copy the blob into OUT_DIR so include_bytes! can find it.
    let js_bin_dest = out_dir.join("embedded_fonts_js.bin");
    fs::copy(&js_blob_src, &js_bin_dest).expect("failed to copy embedded_fonts_js.bin");
    println!("cargo:rerun-if-changed={}", js_blob_src.display());
    println!("cargo:rerun-if-changed={}", js_index_src.display());

    // Parse the JSON index and generate the Rust source for the JS WOFF2 path.
    let js_index_json = fs::read_to_string(&js_index_src)
        .expect("failed to read embedded_fonts_js.json");
    let js_entries: Vec<serde_json::Value> = serde_json::from_str(&js_index_json)
        .expect("failed to parse embedded_fonts_js.json");

    // The generated table holds `(name, offset, length)` so it can live in a
    // `static` on stable Rust — slicing into a `&[u8]` is not yet `const`
    // (rust-lang/rust#143874). `raster::iter_embedded_fonts()` materializes
    // `(&str, &[u8])` pairs at runtime by indexing into the blob.
    let mut body = String::new();
    body.push_str("// Generated by build.rs from excalidraw-image-fonts-{core,cjk,cjk-extra}. Do not edit.\n");
    body.push_str("pub static EMBEDDED_FONTS_BLOB: &[u8] = include_bytes!(\"embedded_fonts.bin\");\n");
    body.push_str("pub static EMBEDDED_FONT_INDEX: &[(&str, usize, usize)] = &[\n");
    for (rel, start, len) in &entries {
        body.push_str(&format!("    (\"{}\", {}, {}),\n", rel, start, len));
    }
    body.push_str("];\n");

    let dest = out_dir.join("embedded_fonts.rs");
    fs::write(&dest, body).expect("failed to write embedded_fonts.rs");

    // Separate generated file for engine.rs (WOFF2 blob + index for the JS path).
    let mut js_body = String::new();
    js_body.push_str("// Generated by build.rs — WOFF2 pre-encoded by wawoff2 for the JS engine. Do not edit.\n");
    js_body.push_str("pub static EMBEDDED_FONTS_JS_BLOB: &[u8] = include_bytes!(\"embedded_fonts_js.bin\");\n");
    js_body.push_str("pub static EMBEDDED_FONTS_JS_INDEX: &[(&str, usize, usize)] = &[\n");
    for entry in &js_entries {
        let key = entry["key"].as_str().expect("missing key in index entry");
        let offset = entry["offset"].as_u64().expect("missing offset");
        let length = entry["length"].as_u64().expect("missing length");
        js_body.push_str(&format!("    (\"{}\", {}, {}),\n", key, offset, length));
    }
    js_body.push_str("];\n");

    let js_dest = out_dir.join("embedded_fonts_js.rs");
    fs::write(&js_dest, js_body).expect("failed to write embedded_fonts_js.rs");
}
