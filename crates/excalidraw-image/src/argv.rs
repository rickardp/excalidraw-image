// R-002 — argv parser for `excalidraw-image`.
//
// PLAN §5.4 documents the CLI surface. This module:
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

/// Output image format. Chosen explicitly via `--format` or inferred from
/// the output path's extension. `Png` is wired in Phase 7 (resvg);
/// Phase 6's main.rs rejects Png with a clear error until PNG-001 lands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Svg,
    Png,
}

impl Format {
    fn from_ext(path: &str) -> Option<Self> {
        let lower = path.to_ascii_lowercase();
        if lower.ends_with(".png") {
            Some(Format::Png)
        } else if lower.ends_with(".svg") || lower.ends_with(".excalidraw.svg") {
            Some(Format::Svg)
        } else {
            None
        }
    }

    fn parse(s: &str) -> Result<Self> {
        match s.to_ascii_lowercase().as_str() {
            "svg" => Ok(Format::Svg),
            "png" => Ok(Format::Png),
            other => bail!("invalid --format '{other}'; expected 'svg' or 'png'"),
        }
    }
}

/// Parsed command-line arguments. Field names match PLAN §5.4 flags.
///
/// `background` defaults to `true`; `--no-background` sets it `false`.
/// `Option<f64>` fields default to "not provided" — `opts_json()` simply
/// omits them so the JS side picks its own defaults (e.g., `padding=10`,
/// `scale=1`).
#[derive(Debug, Clone, PartialEq)]
pub struct Args {
    pub input: String,       // "-" for stdin
    pub output: String,      // "-" for stdout
    pub format: Format,
    pub embed_scene: bool,
    pub background: bool,
    pub dark: bool,
    pub padding: Option<f64>,
    pub scale: Option<f64>,
    pub frame: Option<String>,
    pub max: Option<f64>,
    pub skip_font_inline: bool,
    pub strict_fonts: bool,
}

impl Default for Args {
    fn default() -> Self {
        Args {
            input: "-".to_string(),
            output: "-".to_string(),
            format: Format::Svg,
            embed_scene: false,
            background: true,
            dark: false,
            padding: None,
            scale: None,
            frame: None,
            max: None,
            skip_font_inline: false,
            strict_fonts: false,
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
excalidraw-image — convert .excalidraw scenes to SVG and PNG.

USAGE:
  excalidraw-image <input> [options]

INPUTS:
  <input>                     Path to .excalidraw. Use '-' for stdin.

OUTPUTS:
  -o, --output <file>         Output path. Use '-' for stdout. Default: '-'.
      --format <svg|png>      Output format. Default: infer from --output
                              extension, else svg.
      --embed-scene           Emit editable .excalidraw.svg with scene metadata.

RENDERING:
      --no-background         Omit background rect.
      --dark                  Dark-mode filter.
      --padding <n>           Padding in pixels. Default 10.
      --scale <n>             Scale factor. Default 1.
      --frame <name|id>       Export only the named frame.
      --max <n>               Clamp to max width or height.

FONTS:
      --skip-font-inline      Don't embed @font-face. Viewer must have fonts.
      --strict-fonts          Error on unknown families instead of falling
                              back to Excalifont.

  -h, --help                  Show this help.
  -v, --version               Show version.

EXAMPLES:
  # Convert to SVG (stdout):
  excalidraw-image scene.excalidraw

  # Convert to file (format inferred from extension):
  excalidraw-image scene.excalidraw -o scene.svg
  excalidraw-image scene.excalidraw -o scene.png

  # Editable .excalidraw.svg (round-trips on excalidraw.com):
  excalidraw-image scene.excalidraw --embed-scene -o scene.excalidraw.svg

  # PNG at 2x resolution, capped at 1920px:
  excalidraw-image scene.excalidraw --scale 2 --max 1920 -o scene.png

  # From stdin to stdout:
  cat scene.excalidraw | excalidraw-image - --format svg > scene.svg
";

/// Parse `args` into an `Args`. The iterator should NOT include the
/// binary name — callers passing `std::env::args_os()` should `.skip(1)`
/// first. `--help` and `--version` print and `std::process::exit(0)` from
/// inside this function.
///
/// On argv error (unknown flag, missing value, invalid number), returns
/// `ArgvError::Parse`. Callers should map that to exit code 2 per
/// PLAN §5 (R-008 formalizes this).
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
            Long("embed-scene") => out.embed_scene = true,
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

    out.input = input.unwrap_or_else(|| "-".to_string());

    // Format resolution order (PLAN §5.4):
    //   1. explicit `--format`
    //   2. infer from output extension
    //   3. default: svg
    out.format = if let Some(f) = explicit_format {
        f
    } else if out.output != "-" {
        Format::from_ext(&out.output).unwrap_or(Format::Svg)
    } else {
        Format::Svg
    };

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
    ///   * `exportingFrame` (string, optional)    — PLAN §5.4 maps `--frame`
    ///   * `max`            (number, optional)
    ///   * `skipFontInline` (bool, optional)
    ///   * `strictFonts`    (bool, optional)
    ///
    /// Defaults on the JS side fill in `background=true`, `padding=undefined`
    /// (Excalidraw's own default), `scale=1`. We only emit a key when its
    /// value is meaningful, so future JS-side default changes don't need a
    /// Rust bump.
    pub fn opts_json(&self) -> String {
        use serde_json::{json, Map, Value};
        let mut m: Map<String, Value> = Map::new();
        if self.embed_scene {
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
    fn defaults_when_no_input_or_output() {
        let a = parse_strs(&[]).unwrap();
        assert_eq!(a.input, "-");
        assert_eq!(a.output, "-");
        assert_eq!(a.format, Format::Svg);
        assert!(a.background);
        assert!(!a.dark);
        assert!(!a.embed_scene);
    }

    #[test]
    fn stdin_stdout_explicit() {
        let a = parse_strs(&["-", "-o", "-"]).unwrap();
        assert_eq!(a.input, "-");
        assert_eq!(a.output, "-");
        assert_eq!(a.format, Format::Svg);
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
        assert_eq!(a.format, Format::Png);
    }

    #[test]
    fn format_inferred_from_output_ext_svg() {
        let a = parse_strs(&["scene.excalidraw", "-o", "out.svg"]).unwrap();
        assert_eq!(a.format, Format::Svg);
    }

    #[test]
    fn format_inferred_from_excalidraw_svg_ext() {
        let a = parse_strs(&["scene.excalidraw", "-o", "out.excalidraw.svg"]).unwrap();
        assert_eq!(a.format, Format::Svg);
    }

    #[test]
    fn explicit_format_overrides_extension() {
        // extension says svg, --format says png
        let a = parse_strs(&["scene.excalidraw", "-o", "out.svg", "--format", "png"]).unwrap();
        assert_eq!(a.format, Format::Png);
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
        assert_eq!(a.format, Format::Svg);
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
            "--embed-scene",
            "--dark",
            "--skip-font-inline",
            "--strict-fonts",
        ])
        .unwrap();
        assert!(a.embed_scene);
        assert!(a.dark);
        assert!(a.skip_font_inline);
        assert!(a.strict_fonts);
        assert!(a.background); // unchanged default
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
        let j: serde_json::Value = serde_json::from_str(&a.opts_json()).unwrap();
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
            "--embed-scene",
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
        let j: serde_json::Value = serde_json::from_str(&a.opts_json()).unwrap();
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
        let s = a.opts_json();
        let _: serde_json::Value = serde_json::from_str(&s).unwrap();
    }
}
