// R-002 — argv parser for `excalidraw-image`.
//
// the implementation notes documents the CLI surface. This module:
//   * parses command-line arguments with `lexopt` (minimal, no derive);
//   * normalizes `-` for stdin/stdout;
//   * serializes to the JSON shape that `src/core/index.mjs` `render()`
//     accepts as its `opts` argument;
//   * handles `--help` and `--version` by printing and exiting directly
//     (simpler than a Result<Action, Error> enum for v1).
//
// Host-side parsing lives in Rust; the JS core never sees argv. The Rust
// shell writes a tiny JSON blob describing rendering opts and passes it to
// `__render(scene, opts)` through the engine trampoline (see R-003).

use std::ffi::OsString;

use anyhow::{anyhow, bail, Context, Result};
use lexopt::prelude::*;

/// Parse-phase error. Today this is a newtype around `anyhow::Error` with a
/// single variant, but the enum shape is kept so main.rs can branch on the
/// exit code (2) without string-matching — and so future work can add a
/// `Help` / `Version` variant if we ever need argv to hand control back to
/// main instead of exiting inline.
#[derive(Debug)]
pub enum ArgvError {
    /// Any argv problem: unknown flag, missing value, bad number, non-UTF-8
    /// input. R-008 maps this to exit code 2.
    Parse(anyhow::Error),
}

impl std::fmt::Display for ArgvError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ArgvError::Parse(e) => write!(f, "{e:#}"),
        }
    }
}

impl std::error::Error for ArgvError {}

/// Output format. Chosen explicitly via `--format` or inferred from the
/// output path's extension. `Excalidraw` is the JSON scene format; it is
/// the natural target when reversing an `.excalidraw.svg` or scene-bearing
/// PNG back into editable JSON (the extract path).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Excalidraw,
    Svg,
    Png,
}

impl Format {
    fn from_ext(path: &str) -> Option<Self> {
        let lower = path.to_ascii_lowercase();
        if lower.ends_with(".png") {
            Some(Format::Png)
        } else if lower.ends_with(".excalidraw.svg") || lower.ends_with(".svg") {
            Some(Format::Svg)
        } else if lower.ends_with(".excalidraw") {
            Some(Format::Excalidraw)
        } else {
            None
        }
    }

    fn parse(s: &str) -> Result<Self> {
        match s.to_ascii_lowercase().as_str() {
            "svg" => Ok(Format::Svg),
            "png" => Ok(Format::Png),
            "excalidraw" | "json" => Ok(Format::Excalidraw),
            other => bail!("invalid --format '{other}'; expected 'svg', 'png', or 'excalidraw'"),
        }
    }
}

/// Parsed command-line arguments. Field names match the implementation notes flags.
///
/// `background` defaults to `true`; `--no-background` sets it `false`.
/// `Option<f64>` fields default to "not provided" — `opts_json()` simply
/// omits them so the JS side picks its own defaults (e.g., `padding=10`,
/// `scale=1`).
///
/// `format` is `None` until `main.rs` sniffs the input bytes — the default
/// output format depends on whether the input is `.excalidraw` JSON
/// (defaults to SVG) or an `.excalidraw.svg`/PNG-with-scene (defaults to
/// `.excalidraw` JSON, i.e. extract).
#[derive(Debug, Clone, PartialEq)]
pub struct Args {
    pub input: String,       // "-" for stdin
    pub output: String,      // "-" for stdout
    pub format: Option<Format>,
    /// `Some(true)` ⇐ `--editable`; `Some(false)` ⇐ `--non-editable`;
    /// `None` ⇐ default rules (see `resolve_embed_scene`). The two flags
    /// are mutually exclusive and conflict-checked at parse time.
    pub embed_scene_override: Option<bool>,
    pub background: bool,
    pub dark: bool,
    pub padding: Option<f64>,
    pub scale: Option<f64>,
    pub frame: Option<String>,
    pub max: Option<f64>,
    pub skip_font_inline: bool,
    pub strict_fonts: bool,
    /// `--no-snapshot-cache` — bypass the per-user V8 startup-snapshot
    /// cache (see `engine::snapshot_cache`). The same effect is
    /// available via the `EXCALIDRAW_IMAGE_NO_SNAPSHOT_CACHE=1` env
    /// var; this flag wins.
    pub no_snapshot_cache: bool,
}

impl Default for Args {
    fn default() -> Self {
        Args {
            input: "-".to_string(),
            output: "-".to_string(),
            format: None,
            embed_scene_override: None,
            background: true,
            dark: false,
            padding: None,
            scale: None,
            frame: None,
            max: None,
            skip_font_inline: false,
            strict_fonts: false,
            no_snapshot_cache: false,
        }
    }
}

/// Name/version banner printed by `--version`.
///
/// Hard-coded for v1; a follow-up can extract from `CARGO_PKG_VERSION`
/// and probe the deno_core dep tree. The excalidraw version is the one
/// F-002 pinned in package.json (`@excalidraw/excalidraw@0.18.1`).
const VERSION_BANNER: &str = concat!(
    "excalidraw-image ",
    env!("CARGO_PKG_VERSION"),
    " (excalidraw 0.18.1, deno_core 0.399.0)"
);

const HELP_TEXT: &str = "\
excalidraw-image — convert between .excalidraw, SVG, and PNG.

USAGE:
  excalidraw-image <input> [options]

DIRECTIONS:
  Forward (render):     .excalidraw       →  .svg / .excalidraw.svg / .png
  Reverse (extract):    .excalidraw.svg   →  .excalidraw
                        .png              →  .excalidraw
  Round-trip (re-render): .svg/.png       →  .svg / .excalidraw.svg / .png
                          (extracts the embedded scene, then re-renders.)

  Reverse and round-trip require the input to carry an embedded scene
  (Excalidraw's \"Embed scene\" option, or this CLI's default `.excalidraw.svg`
  / `.excalidraw.png` output, or any output produced with --editable). This
  tool is NOT a general-purpose SVG/PNG reader; an SVG/PNG without the
  Excalidraw payload is rejected with a clear error.

INPUTS:
  <input>                     Path to input file, or '-' for stdin.
                              The format is detected from the bytes
                              (PNG signature, '<' for SVG/XML, '{' for JSON);
                              the input file extension is NOT consulted.

OUTPUTS:
  -o, --output <file>         Output path. Use '-' for stdout. Default: '-'.
      --format <fmt>          Force output format. fmt is one of:
                                excalidraw   .excalidraw JSON (extract)
                                svg          rendered SVG
                                png          rendered PNG
                              Default: infer from --output extension; if
                              stdout, defaults to svg (excalidraw input)
                              or excalidraw (svg/png input).
      --editable              Force the rendered SVG/PNG to embed the
                              .excalidraw scene so it round-trips on
                              excalidraw.com. Default for outputs whose
                              path is `.excalidraw.svg` / `.excalidraw.png`,
                              and for stdout.
      --non-editable          Force a plain image with no embedded scene.
                              Default for outputs whose path is plain
                              `.svg` / `.png` (without the `.excalidraw.`
                              prefix). Mutually exclusive with --editable.

RENDERING (ignored when output format is 'excalidraw'):
      --no-background         Omit the background rectangle.
      --dark                  Apply Excalidraw's dark-mode filter.
      --padding <n>           Padding around content, in pixels. Default 10.
      --scale <n>             Scale factor for raster output. Default 1.
      --frame <name|id>       Export only the named or id-matched frame.
      --max <n>               Clamp width and height to <n> pixels.

FONTS (ignored when output format is 'excalidraw'):
      --skip-font-inline      Don't embed @font-face in SVG. Viewer must
                              already have the fonts installed locally.
      --strict-fonts          Error on unknown font families instead of
                              falling back to Excalifont.

STARTUP CACHE:
      --no-snapshot-cache     Skip the per-user V8 startup-snapshot
                              cache. By default, after the first run on
                              a machine, subsequent invocations restore
                              V8 from a snapshot baked into
                              ~/Library/Caches/excalidraw-image (macOS),
                              $XDG_CACHE_HOME/excalidraw-image (Linux),
                              or %LOCALAPPDATA%\\excalidraw-image\\cache
                              (Windows). The first run pays a small
                              extra cost to spawn a background warmer.
                              The cache is content-addressed and self-
                              prunes on upgrade. Equivalent env vars:
                                EXCALIDRAW_IMAGE_NO_SNAPSHOT_CACHE=1
                                EXCALIDRAW_IMAGE_CACHE_DIR=<path>

  -h, --help                  Show this help.
  -v, --version               Show version.

EXIT CODES:
  0   success
  1   runtime error (missing/invalid input, no embedded scene, render
      failure, write failure)
  2   argv error (unknown flag, bad number, conflicting flags)

EXAMPLES:
  # Forward — render to SVG (stdout):
  excalidraw-image scene.excalidraw

  # Forward — write to a file (format inferred from extension):
  excalidraw-image scene.excalidraw -o scene.svg
  excalidraw-image scene.excalidraw -o scene.png

  # Forward — round-trippable .excalidraw.svg (re-opens on excalidraw.com).
  # The .excalidraw.svg / .excalidraw.png extensions imply --editable.
  excalidraw-image scene.excalidraw -o scene.excalidraw.svg
  excalidraw-image scene.excalidraw -o scene.excalidraw.png

  # Forward — plain SVG/PNG with NO embedded scene (smaller, not editable).
  # Plain .svg / .png extensions imply --non-editable.
  excalidraw-image scene.excalidraw -o scene.svg
  excalidraw-image scene.excalidraw --scale 2 --max 1920 -o scene.png

  # Reverse — pull the .excalidraw out of an .excalidraw.svg:
  excalidraw-image scene.excalidraw.svg -o scene.excalidraw

  # Reverse — pull the scene out of a PNG that has it embedded:
  excalidraw-image scene.png -o scene.excalidraw

  # Round-trip — re-render an .excalidraw.svg as PNG without touching JSON:
  excalidraw-image scene.excalidraw.svg -o scene.png

  # Stdin → stdout (format detected from input bytes):
  cat scene.excalidraw     | excalidraw-image - --format svg        > scene.svg
  cat scene.excalidraw.svg | excalidraw-image - --format excalidraw > scene.excalidraw
  cat scene.png            | excalidraw-image - --format excalidraw > scene.excalidraw
";

/// Parse `args` into an `Args`. The iterator should NOT include the
/// binary name — callers passing `std::env::args_os()` should `.skip(1)`
/// first. `--help` and `--version` print and `std::process::exit(0)` from
/// inside this function.
///
/// On argv error (unknown flag, missing value, invalid number), returns
/// `ArgvError::Parse`. Callers should map that to exit code 2 per
/// the implementation notes (R-008 formalizes this).
pub fn parse(args: impl IntoIterator<Item = OsString>) -> std::result::Result<Args, ArgvError> {
    parse_inner(args).map_err(ArgvError::Parse)
}

fn parse_inner(args: impl IntoIterator<Item = OsString>) -> Result<Args> {
    let mut parser = lexopt::Parser::from_args(args);
    let mut out = Args::default();
    let mut input: Option<String> = None;
    // Explicit-format flag overrides extension inference.
    let mut explicit_format: Option<Format> = None;

    while let Some(arg) = parser.next()? {
        match arg {
            Short('o') | Long("output") => {
                out.output = parser
                    .value()?
                    .into_string()
                    .map_err(|_| anyhow!("--output value is not valid UTF-8"))?;
            }
            Long("format") => {
                let v = parser
                    .value()?
                    .into_string()
                    .map_err(|_| anyhow!("--format value is not valid UTF-8"))?;
                explicit_format = Some(Format::parse(&v)?);
            }
            Long("editable") => {
                if out.embed_scene_override == Some(false) {
                    bail!("--editable conflicts with --non-editable");
                }
                out.embed_scene_override = Some(true);
            }
            Long("non-editable") => {
                if out.embed_scene_override == Some(true) {
                    bail!("--non-editable conflicts with --editable");
                }
                out.embed_scene_override = Some(false);
            }
            Long("no-background") => out.background = false,
            Long("dark") => out.dark = true,
            Long("padding") => {
                out.padding = Some(parse_f64(&mut parser, "--padding")?);
            }
            Long("scale") => {
                out.scale = Some(parse_f64(&mut parser, "--scale")?);
            }
            Long("frame") => {
                let v = parser
                    .value()?
                    .into_string()
                    .map_err(|_| anyhow!("--frame value is not valid UTF-8"))?;
                out.frame = Some(v);
            }
            Long("max") => {
                out.max = Some(parse_f64(&mut parser, "--max")?);
            }
            Long("skip-font-inline") => out.skip_font_inline = true,
            Long("strict-fonts") => out.strict_fonts = true,
            Long("no-snapshot-cache") => out.no_snapshot_cache = true,
            Short('h') | Long("help") => {
                print!("{HELP_TEXT}");
                std::process::exit(0);
            }
            Short('v') | Long("version") => {
                println!("{VERSION_BANNER}");
                std::process::exit(0);
            }
            Value(val) => {
                if input.is_some() {
                    bail!(
                        "unexpected positional argument '{}'; only one input is accepted",
                        val.to_string_lossy()
                    );
                }
                input = Some(
                    val.into_string()
                        .map_err(|_| anyhow!("input path is not valid UTF-8"))?,
                );
            }
            other => return Err(other.unexpected().into()),
        }
    }

    // No positional input is the friendly "show help" case. `-` is the
    // only way to ask for stdin — keeps the docs honest and stops the
    // binary from blocking on an empty terminal when invoked bare.
    let Some(input_path) = input else {
        print!("{HELP_TEXT}");
        std::process::exit(0);
    };
    out.input = input_path;

    // Output-format resolution at parse time:
    //   1. explicit `--format` wins
    //   2. else infer from output extension (only when --output is a real path)
    //   3. else leave as None — main.rs picks a default after sniffing the
    //      input bytes (`.excalidraw` → svg; `.excalidraw.svg`/PNG → extract).
    out.format = explicit_format.or_else(|| {
        if out.output == "-" {
            None
        } else {
            Format::from_ext(&out.output)
        }
    });

    Ok(out)
}

fn parse_f64(parser: &mut lexopt::Parser, flag: &str) -> Result<f64> {
    let v = parser.value()?;
    let s = v
        .into_string()
        .map_err(|_| anyhow!("{flag} value is not valid UTF-8"))?;
    s.parse::<f64>()
        .with_context(|| format!("{flag} expects a number, got '{s}'"))
}

impl Args {
    /// Serialize rendering options to the JSON shape that
    /// `src/core/index.mjs` `render()` consumes as its `opts` argument.
    ///
    /// Keys (per the `render()` destructure in index.mjs):
    ///   * `embedScene`     (bool)
    ///   * `background`     (bool)                — falsy ⇒ `exportBackground:false`
    ///   * `dark`           (bool)
    ///   * `padding`        (number, optional)
    ///   * `scale`          (number, optional)
    ///   * `exportingFrame` (string, optional)    — the implementation notes maps `--frame`
    ///   * `max`            (number, optional)
    ///   * `skipFontInline` (bool, optional)
    ///   * `strictFonts`    (bool, optional)
    ///
    /// Defaults on the JS side fill in `background=true`, `padding=undefined`
    /// (Excalidraw's own default), `scale=1`. We only emit a key when its
    /// value is meaningful, so future JS-side default changes don't need a
    /// Rust bump.
    /// Resolve the effective "embed the scene metadata in the rendered
    /// image?" decision for a given output format and path.
    ///
    /// Rules (highest priority first):
    ///   1. `--editable` ⇒ true.
    ///   2. `--non-editable` ⇒ false.
    ///   3. Output extension ends `.excalidraw.svg` / `.excalidraw.png` ⇒ true.
    ///   4. Output extension ends plain `.svg` / `.png` ⇒ false.
    ///   5. Otherwise (stdout, unknown extension) ⇒ true (editable default).
    ///
    /// For `Format::Excalidraw` the value is irrelevant — there is no
    /// rendered image to embed into; we return `false` so callers don't
    /// accidentally inject SVG metadata into raw scene JSON.
    pub fn resolve_embed_scene(&self, fmt: Format, output_path: &str) -> bool {
        if let Some(v) = self.embed_scene_override {
            return v;
        }
        let lower = output_path.to_ascii_lowercase();
        match fmt {
            Format::Excalidraw => false,
            Format::Svg => {
                if lower.ends_with(".excalidraw.svg") {
                    true
                } else if lower.ends_with(".svg") {
                    false
                } else {
                    true
                }
            }
            Format::Png => {
                if lower.ends_with(".excalidraw.png") {
                    true
                } else if lower.ends_with(".png") {
                    false
                } else {
                    true
                }
            }
        }
    }

    pub fn opts_json(&self, embed_scene: bool) -> String {
        use serde_json::{json, Map, Value};
        let mut m: Map<String, Value> = Map::new();
        if embed_scene {
            m.insert("embedScene".to_string(), json!(true));
        }
        // `background` is always emitted: the JS side defaults to true, but
        // being explicit means `--no-background` unambiguously flips it.
        m.insert("background".to_string(), json!(self.background));
        if self.dark {
            m.insert("dark".to_string(), json!(true));
        }
        if let Some(p) = self.padding {
            m.insert("padding".to_string(), json!(p));
        }
        if let Some(s) = self.scale {
            m.insert("scale".to_string(), json!(s));
        }
        if let Some(f) = &self.frame {
            m.insert("exportingFrame".to_string(), json!(f));
        }
        if let Some(x) = self.max {
            m.insert("max".to_string(), json!(x));
        }
        if self.skip_font_inline {
            m.insert("skipFontInline".to_string(), json!(true));
        }
        if self.strict_fonts {
            m.insert("strictFonts".to_string(), json!(true));
        }
        Value::Object(m).to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_strs(args: &[&str]) -> std::result::Result<Args, ArgvError> {
        let v: Vec<OsString> = args.iter().map(|s| OsString::from(*s)).collect();
        parse(v)
    }

    #[test]
    fn defaults_when_only_input_given() {
        // Bare `excalidraw-image` (no positional) prints help and exits, so
        // we can't unit-test that branch directly — covered by the smoke
        // test instead. Here we assert the default field values when the
        // user passes only the input.
        let a = parse_strs(&["scene.excalidraw"]).unwrap();
        assert_eq!(a.input, "scene.excalidraw");
        assert_eq!(a.output, "-");
        assert_eq!(a.format, None); // resolved by main.rs after sniffing input
        assert!(a.background);
        assert!(!a.dark);
        assert_eq!(a.embed_scene_override, None);
    }

    #[test]
    fn stdin_stdout_explicit() {
        let a = parse_strs(&["-", "-o", "-"]).unwrap();
        assert_eq!(a.input, "-");
        assert_eq!(a.output, "-");
        assert_eq!(a.format, None);
    }

    #[test]
    fn positional_input_is_captured() {
        let a = parse_strs(&["scene.excalidraw"]).unwrap();
        assert_eq!(a.input, "scene.excalidraw");
        assert_eq!(a.output, "-");
    }

    #[test]
    fn format_inferred_from_output_ext_png() {
        let a = parse_strs(&["scene.excalidraw", "-o", "out.png"]).unwrap();
        assert_eq!(a.format, Some(Format::Png));
    }

    #[test]
    fn format_inferred_from_output_ext_svg() {
        let a = parse_strs(&["scene.excalidraw", "-o", "out.svg"]).unwrap();
        assert_eq!(a.format, Some(Format::Svg));
    }

    #[test]
    fn format_inferred_from_excalidraw_svg_ext() {
        let a = parse_strs(&["scene.excalidraw", "-o", "out.excalidraw.svg"]).unwrap();
        assert_eq!(a.format, Some(Format::Svg));
    }

    #[test]
    fn format_inferred_from_excalidraw_ext() {
        let a = parse_strs(&["scene.excalidraw.svg", "-o", "out.excalidraw"]).unwrap();
        assert_eq!(a.format, Some(Format::Excalidraw));
    }

    #[test]
    fn explicit_format_overrides_extension() {
        // extension says svg, --format says png
        let a = parse_strs(&["scene.excalidraw", "-o", "out.svg", "--format", "png"]).unwrap();
        assert_eq!(a.format, Some(Format::Png));
    }

    #[test]
    fn explicit_format_excalidraw_accepted() {
        let a = parse_strs(&["scene.excalidraw.svg", "--format", "excalidraw"]).unwrap();
        assert_eq!(a.format, Some(Format::Excalidraw));
        // `json` alias works too.
        let a = parse_strs(&["scene.excalidraw.svg", "--format", "json"]).unwrap();
        assert_eq!(a.format, Some(Format::Excalidraw));
    }

    #[test]
    fn long_output_and_format_accepted() {
        let a = parse_strs(&[
            "scene.excalidraw",
            "--output",
            "out.png",
            "--format",
            "svg",
        ])
        .unwrap();
        assert_eq!(a.output, "out.png");
        assert_eq!(a.format, Some(Format::Svg));
    }

    #[test]
    fn no_background_flips_background_false() {
        let a = parse_strs(&["scene.excalidraw", "--no-background"]).unwrap();
        assert!(!a.background);
    }

    #[test]
    fn all_bool_flags() {
        let a = parse_strs(&[
            "scene.excalidraw",
            "--editable",
            "--dark",
            "--skip-font-inline",
            "--strict-fonts",
        ])
        .unwrap();
        assert_eq!(a.embed_scene_override, Some(true));
        assert!(a.dark);
        assert!(a.skip_font_inline);
        assert!(a.strict_fonts);
        assert!(a.background); // unchanged default
    }

    #[test]
    fn editable_and_non_editable_conflict() {
        let err =
            parse_strs(&["scene.excalidraw", "--editable", "--non-editable"]).unwrap_err();
        assert!(err.to_string().contains("conflicts"), "err: {err}");
    }

    #[test]
    fn embed_scene_default_inferred_from_output_extension() {
        // Plain .svg → not editable.
        let a = parse_strs(&["scene.excalidraw", "-o", "out.svg"]).unwrap();
        assert_eq!(a.embed_scene_override, None);
        assert!(!a.resolve_embed_scene(Format::Svg, &a.output));

        // .excalidraw.svg → editable.
        let a = parse_strs(&["scene.excalidraw", "-o", "out.excalidraw.svg"]).unwrap();
        assert!(a.resolve_embed_scene(Format::Svg, &a.output));

        // Plain .png → not editable.
        let a = parse_strs(&["scene.excalidraw", "-o", "out.png"]).unwrap();
        assert!(!a.resolve_embed_scene(Format::Png, &a.output));

        // .excalidraw.png → editable.
        let a = parse_strs(&["scene.excalidraw", "-o", "out.excalidraw.png"]).unwrap();
        assert!(a.resolve_embed_scene(Format::Png, &a.output));

        // Stdout → editable by default.
        let a = parse_strs(&["scene.excalidraw"]).unwrap();
        assert!(a.resolve_embed_scene(Format::Svg, &a.output));
        assert!(a.resolve_embed_scene(Format::Png, &a.output));
    }

    #[test]
    fn embed_scene_flags_override_extension() {
        let a = parse_strs(&["scene.excalidraw", "-o", "out.svg", "--editable"]).unwrap();
        assert!(a.resolve_embed_scene(Format::Svg, &a.output));

        let a = parse_strs(&[
            "scene.excalidraw",
            "-o",
            "out.excalidraw.svg",
            "--non-editable",
        ])
        .unwrap();
        assert!(!a.resolve_embed_scene(Format::Svg, &a.output));
    }

    #[test]
    fn numeric_flags_parse() {
        let a = parse_strs(&[
            "scene.excalidraw",
            "--padding",
            "20",
            "--scale",
            "2.5",
            "--max",
            "800",
        ])
        .unwrap();
        assert_eq!(a.padding, Some(20.0));
        assert_eq!(a.scale, Some(2.5));
        assert_eq!(a.max, Some(800.0));
    }

    #[test]
    fn frame_flag_captured() {
        let a = parse_strs(&["scene.excalidraw", "--frame", "Frame 1"]).unwrap();
        assert_eq!(a.frame.as_deref(), Some("Frame 1"));
    }

    #[test]
    fn unknown_flag_errors() {
        let err = parse_strs(&["scene.excalidraw", "--nope"]).unwrap_err();
        let msg = err.to_string().to_lowercase();
        assert!(msg.contains("nope") || msg.contains("invalid"), "err: {msg}");
    }

    #[test]
    fn invalid_number_errors() {
        let err = parse_strs(&["scene.excalidraw", "--scale", "not-a-number"]).unwrap_err();
        assert!(
            err.to_string().contains("--scale"),
            "err: {}",
            err
        );
    }

    #[test]
    fn invalid_format_errors() {
        let err = parse_strs(&["scene.excalidraw", "--format", "bmp"]).unwrap_err();
        assert!(err.to_string().contains("bmp"), "err: {}", err);
    }

    #[test]
    fn duplicate_positional_errors() {
        let err = parse_strs(&["a.excalidraw", "b.excalidraw"]).unwrap_err();
        assert!(
            err.to_string().contains("positional"),
            "err: {}",
            err
        );
    }

    #[test]
    fn opts_json_default_has_background_true() {
        let a = Args::default();
        let j: serde_json::Value = serde_json::from_str(&a.opts_json(false)).unwrap();
        assert_eq!(j["background"], serde_json::json!(true));
        // absent keys should not appear
        assert!(j.get("embedScene").is_none());
        assert!(j.get("dark").is_none());
        assert!(j.get("padding").is_none());
        assert!(j.get("scale").is_none());
        assert!(j.get("exportingFrame").is_none());
        assert!(j.get("max").is_none());
        assert!(j.get("skipFontInline").is_none());
        assert!(j.get("strictFonts").is_none());
    }

    #[test]
    fn opts_json_shape_all_keys() {
        let a = parse_strs(&[
            "scene.excalidraw",
            "--editable",
            "--no-background",
            "--dark",
            "--padding",
            "8",
            "--scale",
            "2",
            "--frame",
            "intro",
            "--max",
            "1024",
            "--skip-font-inline",
            "--strict-fonts",
        ])
        .unwrap();
        let j: serde_json::Value = serde_json::from_str(&a.opts_json(true)).unwrap();
        assert_eq!(j["embedScene"], serde_json::json!(true));
        assert_eq!(j["background"], serde_json::json!(false));
        assert_eq!(j["dark"], serde_json::json!(true));
        assert_eq!(j["padding"], serde_json::json!(8.0));
        assert_eq!(j["scale"], serde_json::json!(2.0));
        assert_eq!(j["exportingFrame"], serde_json::json!("intro"));
        assert_eq!(j["max"], serde_json::json!(1024.0));
        assert_eq!(j["skipFontInline"], serde_json::json!(true));
        assert_eq!(j["strictFonts"], serde_json::json!(true));
    }

    #[test]
    fn opts_json_is_valid_json() {
        // sanity: parsing is round-trip safe
        let a = Args::default();
        let s = a.opts_json(false);
        let _: serde_json::Value = serde_json::from_str(&s).unwrap();
    }
}
