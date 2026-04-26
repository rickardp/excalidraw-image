// R-004 / PNG-002 — `excalidraw-image` CLI entry point.
//
// Wires:
//   * argv parsing (R-002) — `argv::parse` takes an iterator excluding argv[0],
//     handles `--help` / `--version` internally (printing + `exit(0)`), and
//     returns `anyhow::Error` on argv problems (unknown flag, bad number,
//     duplicate positional).
//   * file / stdin I/O — `-` means stdin for input and stdout for output.
//   * engine invocation (R-003) — one-shot `Engine::new()` + `render()`. No
//     warm reuse yet; cold-start is already <100 ms per F-002.
//   * PNG rasterization (PNG-001) — when `--format png` (or `.png` extension),
//     hand the SVG string to `raster::svg_to_png` which returns PNG bytes.
//
// Exit-code policy (R-008 acceptance, PLAN §5.8):
//   0 — success.
//   1 — runtime errors: missing input file, invalid JSON scene, JS-side
//       throw, or rasterization failure.
//   2 — argv errors: unknown flag, bad number, duplicate positional.
//
// The top-level `main` is a thin wrapper: it converts `run()`'s error into a
// stderr line and the right exit code. Anything more clever (stack traces,
// structured logging) is not earned at v1 scope.

use std::io::{Read, Write};

use anyhow::Context;

use excalidraw_image::argv::{self, ArgvError, Format};
use excalidraw_image::engine;
use excalidraw_image::raster;

#[tokio::main(flavor = "current_thread")]
async fn main() {
    match run().await {
        Ok(()) => {}
        Err(RunError::Argv(e)) => {
            // argv errors go through lexopt / our own bail!s. Per R-008 the
            // user-facing message ends with a hint to `--help`.
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

/// `main()`'s error type encodes the exit-code split between argv (2) and
/// runtime (1) without leaking a dedicated enum out of the library.
enum RunError {
    Argv(anyhow::Error),
    Runtime(anyhow::Error),
}

async fn run() -> Result<(), RunError> {
    // Step 1 — argv. Any parse failure is exit-code 2.
    let args = argv::parse(std::env::args_os().skip(1)).map_err(|e| match e {
        ArgvError::Parse(err) => RunError::Argv(err),
    })?;

    // Step 2 — read input. Per PLAN §5.3, `-` means stdin.
    let scene = read_input(&args.input).map_err(RunError::Runtime)?;

    // Step 3 — render JS side → SVG string.
    let mut engine = engine::Engine::new();
    let result = engine
        .render(&scene, &args.opts_json())
        .await
        .context("render failed")
        .map_err(RunError::Runtime)?;

    // Step 4 — pick output bytes. SVG goes out raw (no trailing newline so
    // `deno run … dev.mjs` and the Rust binary stay byte-identical when
    // dev.mjs does `Deno.stdout.write`). PNG goes through resvg with the
    // embedded fontdb (PNG-001).
    let bytes: Vec<u8> = match args.format {
        Format::Svg => result.svg.into_bytes(),
        Format::Png => {
            let raster_opts = raster::RasterOptions {
                scale: args.scale.map(|s| s as f32),
                max: args.max.map(|m| m as u32),
            };
            raster::svg_to_png(&result.svg, &raster_opts)
                .context("PNG rasterization failed")
                .map_err(RunError::Runtime)?
        }
    };

    // Step 5 — write output.
    write_output(&args.output, &bytes).map_err(RunError::Runtime)?;

    Ok(())
}

fn read_input(path: &str) -> anyhow::Result<String> {
    match path {
        "-" => {
            let mut s = String::new();
            std::io::stdin()
                .read_to_string(&mut s)
                .context("failed to read scene from stdin")?;
            Ok(s)
        }
        p => std::fs::read_to_string(p).with_context(|| format!("failed to read {p}")),
    }
}

fn write_output(path: &str, bytes: &[u8]) -> anyhow::Result<()> {
    match path {
        "-" => std::io::stdout()
            .write_all(bytes)
            .context("failed to write SVG to stdout"),
        p => std::fs::write(p, bytes).with_context(|| format!("failed to write {p}")),
    }
}
