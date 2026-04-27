// `excalidraw-image` CLI entry point.
//
// Pipeline:
//   1. Parse argv. `--help` / `--version` exit inside `parse`.
//   2. Read input bytes (file or stdin).
//   3. Sniff the bytes — input format is decided by content, never by the
//      input path's extension.
//   4. Resolve the output format. Precedence:
//        a. `--format` (explicit) wins.
//        b. Else output path extension.
//        c. Else default by input: Excalidraw → Svg, Svg/Png → Excalidraw.
//   5. Resolve `embed_scene` (editable vs. plain) for the output. Defaults
//      key off the output extension (`.excalidraw.svg` / `.excalidraw.png`
//      → editable; plain `.svg` / `.png` → not).
//   6. Dispatch:
//        - Forward (Excalidraw → Svg/Png): JS render → optional rasterize →
//          optional PNG tEXt embed. SVG embedding happens inside the JS
//          render via `exportEmbedScene`.
//        - Reverse (Svg/Png → Excalidraw): pure-Rust extract.
//        - Round-trip (Svg/Png → Svg/Png): extract, then forward path.
//        - Pass-through (Excalidraw → Excalidraw): copy bytes.
//      Reverse / round-trip require the input to embed an Excalidraw
//      payload; missing payload is a clear runtime error (this CLI is not
//      a general-purpose SVG/PNG reader).
//
// Exit-code policy:
//   0 — success.
//   1 — runtime errors: missing input, invalid JSON scene, JS-side throw,
//       missing embedded payload, rasterization failure, write failure.
//   2 — argv errors: unknown flag, bad number, conflicting flags.

use std::io::{Read, Write};

use anyhow::Context;

use excalidraw_image::argv::{self, ArgvError, Format};
use excalidraw_image::embed;
use excalidraw_image::engine;
use excalidraw_image::extract::{self, InputKind};
use excalidraw_image::raster;

#[tokio::main(flavor = "current_thread")]
async fn main() {
    match run().await {
        Ok(()) => {}
        Err(RunError::Argv(e)) => {
            eprintln!("error: {e:#}");
            eprintln!("run `excalidraw-image --help` for usage.");
            std::process::exit(2);
        }
        Err(RunError::Runtime(e)) => {
            eprintln!("error: {e:#}");
            std::process::exit(1);
        }
    }
}

enum RunError {
    Argv(anyhow::Error),
    Runtime(anyhow::Error),
}

async fn run() -> Result<(), RunError> {
    // Step 1 — argv. Any parse failure is exit-code 2.
    let args = argv::parse(std::env::args_os().skip(1)).map_err(|e| match e {
        ArgvError::Parse(err) => RunError::Argv(err),
    })?;

    // Step 2 — read input bytes. `-` means stdin.
    let input_bytes = read_input(&args.input).map_err(RunError::Runtime)?;

    // Step 3 — sniff input bytes.
    let input_kind = extract::sniff(&input_bytes).map_err(RunError::Runtime)?;

    // Step 4 — resolve output format from input + flags.
    let output_format = resolve_output_format(args.format, input_kind);

    // Step 5 — resolve embed_scene for the output.
    let embed_scene = args.resolve_embed_scene(output_format, &args.output);

    // Step 6 — dispatch.
    let bytes = match (input_kind, output_format) {
        (InputKind::Excalidraw, Format::Excalidraw) => input_bytes,

        (InputKind::Excalidraw, Format::Svg) => {
            let scene = utf8_input(input_bytes, "input .excalidraw")
                .map_err(RunError::Runtime)?;
            render_svg(&scene, &args, embed_scene)
                .await
                .map_err(RunError::Runtime)?
                .into_bytes()
        }

        (InputKind::Excalidraw, Format::Png) => {
            let scene = utf8_input(input_bytes, "input .excalidraw")
                .map_err(RunError::Runtime)?;
            render_png(&scene, &args, embed_scene)
                .await
                .map_err(RunError::Runtime)?
        }

        (InputKind::Svg, Format::Excalidraw) => {
            let svg = utf8_input(input_bytes, "SVG input").map_err(RunError::Runtime)?;
            extract::extract_from_svg(&svg)
                .map_err(RunError::Runtime)?
                .into_bytes()
        }

        (InputKind::Png, Format::Excalidraw) => extract::extract_from_png(&input_bytes)
            .map_err(RunError::Runtime)?
            .into_bytes(),

        (InputKind::Svg, Format::Svg) => {
            let svg = utf8_input(input_bytes, "SVG input").map_err(RunError::Runtime)?;
            let scene = extract::extract_from_svg(&svg).map_err(RunError::Runtime)?;
            render_svg(&scene, &args, embed_scene)
                .await
                .map_err(RunError::Runtime)?
                .into_bytes()
        }
        (InputKind::Png, Format::Svg) => {
            let scene = extract::extract_from_png(&input_bytes).map_err(RunError::Runtime)?;
            render_svg(&scene, &args, embed_scene)
                .await
                .map_err(RunError::Runtime)?
                .into_bytes()
        }

        (InputKind::Svg, Format::Png) => {
            let svg = utf8_input(input_bytes, "SVG input").map_err(RunError::Runtime)?;
            let scene = extract::extract_from_svg(&svg).map_err(RunError::Runtime)?;
            render_png(&scene, &args, embed_scene)
                .await
                .map_err(RunError::Runtime)?
        }
        (InputKind::Png, Format::Png) => {
            let scene = extract::extract_from_png(&input_bytes).map_err(RunError::Runtime)?;
            render_png(&scene, &args, embed_scene)
                .await
                .map_err(RunError::Runtime)?
        }
    };

    write_output(&args.output, &bytes).map_err(RunError::Runtime)?;
    Ok(())
}

fn resolve_output_format(requested: Option<Format>, input: InputKind) -> Format {
    if let Some(f) = requested {
        return f;
    }
    match input {
        InputKind::Excalidraw => Format::Svg,
        InputKind::Svg | InputKind::Png => Format::Excalidraw,
    }
}

/// Run the JS render pipeline once, returning the SVG string. Embeds the
/// scene via Excalidraw's own `exportEmbedScene` flag when `embed_scene`.
async fn render_svg(
    scene_json: &str,
    args: &argv::Args,
    embed_scene: bool,
) -> anyhow::Result<String> {
    let mut engine = engine::Engine::new();
    let result = engine
        .render(scene_json, &args.opts_json(embed_scene))
        .await
        .context("render failed")?;
    Ok(result.svg)
}

/// Forward path to PNG: render SVG (without scene embed — PNG carries the
/// scene in a tEXt chunk instead) and rasterize. Then, when `embed_scene`,
/// inject the scene via `embed::embed_scene_in_png`.
async fn render_png(
    scene_json: &str,
    args: &argv::Args,
    embed_scene: bool,
) -> anyhow::Result<Vec<u8>> {
    // The JS-side `exportEmbedScene` only affects SVG output. For PNG, the
    // tEXt chunk is added by us after rasterization, so we render without it.
    let svg = render_svg(scene_json, args, false).await?;

    let raster_opts = raster::RasterOptions {
        scale: args.scale.map(|s| s as f32),
        max: args.max.map(|m| m as u32),
    };
    let png = raster::svg_to_png(&svg, &raster_opts).context("PNG rasterization failed")?;

    if embed_scene {
        embed::embed_scene_in_png(&png, scene_json).context("PNG scene embed failed")
    } else {
        Ok(png)
    }
}

fn utf8_input(bytes: Vec<u8>, label: &str) -> anyhow::Result<String> {
    String::from_utf8(bytes).with_context(|| format!("{label} is not valid UTF-8"))
}

fn read_input(path: &str) -> anyhow::Result<Vec<u8>> {
    match path {
        "-" => {
            let mut v = Vec::new();
            std::io::stdin()
                .read_to_end(&mut v)
                .context("failed to read input from stdin")?;
            Ok(v)
        }
        p => std::fs::read(p).with_context(|| format!("failed to read {p}")),
    }
}

fn write_output(path: &str, bytes: &[u8]) -> anyhow::Result<()> {
    match path {
        "-" => std::io::stdout()
            .write_all(bytes)
            .context("failed to write output to stdout"),
        p => std::fs::write(p, bytes).with_context(|| format!("failed to write {p}")),
    }
}
