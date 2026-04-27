// Reverse conversion — pull the embedded `.excalidraw` scene out of an
// `.excalidraw.svg` or PNG-with-tEXt-chunk that was previously exported with
// `exportEmbedScene` (Excalidraw's "Embed scene" / our `--embed-scene`).
//
// Excalidraw's embed format (JS source: `Si` / `vi` in the prod bundle):
//
//   payload = JSON.stringify({
//     version: "1",
//     encoding: "bstring",
//     compressed: <bool>,
//     encoded:    <bstring>     // either deflated bytes or UTF-8 of original
//   })
//
//   SVG carrier (payload-version 2 today):
//     <metadata>
//       <!-- payload-type:application/vnd.excalidraw+json -->
//       <!-- payload-version:2 -->
//       <!-- payload-start --> btoa(payload)               <!-- payload-end -->
//     </metadata>
//
//   SVG carrier (legacy payload-version 1):
//       <!-- payload-start --> btoa(latin1(utf8(payload))) <!-- payload-end -->
//
//   PNG carrier:
//     tEXt chunk, keyword = "application/vnd.excalidraw+json", text = payload
//     (latin1, per PNG spec).
//
// "bstring" here is Excalidraw's term for a JS string of code units in
// `0x00..=0xFF` — i.e. the byte sequence stored as one byte per char. We
// recover bytes by masking each char to `u8`.
//
// Decoding flow (both carriers):
//   1. Pull the base64 (SVG) or tEXt text (PNG).
//   2. Base64-decode (SVG only). For PNG the tEXt data IS the envelope.
//   3. Recover the envelope JSON as text:
//        - SVG payload-version 1: bytes are UTF-8 of the JSON.
//        - SVG payload-version 2: bytes are latin-1 of the JSON.
//        - PNG: bytes are latin-1 of the JSON.
//   4. Parse the envelope.
//   5. Map `encoded` (each char → low byte) back to bytes.
//   6. If `compressed`, zlib-inflate; else interpret as UTF-8.

use anyhow::{anyhow, bail, Context, Result};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use flate2::read::ZlibDecoder;
use std::io::Read;

/// What we sniffed the input as. Used by the CLI to decide whether to
/// run the JS render path (Excalidraw) or the extract path (Svg/Png).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputKind {
    /// `.excalidraw` scene — JSON. Forward render.
    Excalidraw,
    /// `.excalidraw.svg` (or any SVG carrying an Excalidraw scene). Reverse extract.
    Svg,
    /// `.png` with an Excalidraw `tEXt` chunk. Reverse extract.
    Png,
}

/// Sniff `bytes` to decide whether to render or extract. Looks at the first
/// non-whitespace byte:
///
///   * `\x89PNG\r\n\x1a\n` prefix          → `Png`
///   * `<` (XML/SVG)                       → `Svg`
///   * `{` (JSON object)                   → `Excalidraw`
///   * anything else                       → error with a short hex preview
///
/// Cheap; we don't try to parse anything yet. The downstream stage
/// (extract or render) does the real validation and returns a typed error
/// if the bytes don't actually contain what the prefix promised.
pub fn sniff(bytes: &[u8]) -> Result<InputKind> {
    const PNG_SIG: &[u8] = b"\x89PNG\r\n\x1a\n";
    if bytes.starts_with(PNG_SIG) {
        return Ok(InputKind::Png);
    }
    // Skip BOM + leading whitespace for the text formats. Excalidraw's
    // own exporter never emits a BOM, but users (or other tools) might
    // write one, and `serde_json` accepts JSON with leading whitespace —
    // so we should too.
    let trimmed = trim_text_lead(bytes);
    match trimmed.first() {
        Some(b'<') => Ok(InputKind::Svg),
        Some(b'{') => Ok(InputKind::Excalidraw),
        _ => {
            let head = &bytes[..bytes.len().min(8)];
            bail!(
                "input format not recognized (expected .excalidraw JSON, SVG, or PNG); first bytes: {}",
                hex_preview(head)
            )
        }
    }
}

fn trim_text_lead(b: &[u8]) -> &[u8] {
    let b = b.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(b);
    let mut i = 0;
    while i < b.len() && (b[i] == b' ' || b[i] == b'\t' || b[i] == b'\n' || b[i] == b'\r') {
        i += 1;
    }
    &b[i..]
}

fn hex_preview(b: &[u8]) -> String {
    b.iter()
        .map(|x| format!("{x:02x}"))
        .collect::<Vec<_>>()
        .join(" ")
}

/// Extract the embedded `.excalidraw` JSON from an SVG that Excalidraw (or
/// this CLI with `--embed-scene`) produced. Returns the JSON as a UTF-8
/// string, suitable for writing to `<scene>.excalidraw`.
///
/// Errors are user-facing: missing payload, wrong version, malformed envelope.
pub fn extract_from_svg(svg: &str) -> Result<String> {
    if !svg.contains("payload-type:application/vnd.excalidraw+json") {
        bail!(
            "SVG does not contain an embedded Excalidraw scene \
             (no `payload-type:application/vnd.excalidraw+json` marker). \
             excalidraw-image only extracts SVGs exported with `--embed-scene` or \
             Excalidraw's \"Embed scene\" option."
        );
    }

    let start_marker = "<!-- payload-start -->";
    let end_marker = "<!-- payload-end -->";
    let s = svg
        .find(start_marker)
        .ok_or_else(|| anyhow!("SVG missing `<!-- payload-start -->` marker"))?
        + start_marker.len();
    let e_rel = svg[s..]
        .find(end_marker)
        .ok_or_else(|| anyhow!("SVG missing `<!-- payload-end -->` marker"))?;
    let b64 = svg[s..s + e_rel].trim();

    let version = parse_payload_version(svg);
    let raw = B64
        .decode(b64.as_bytes())
        .context("payload is not valid base64")?;

    // SVG payload-version 1 base64-encoded UTF-8(JSON); v2 base64-encoded latin1(JSON).
    let envelope = if version <= 1 {
        String::from_utf8(raw).context("payload-version 1: payload is not valid UTF-8")?
    } else {
        latin1_to_string(&raw)
    };

    decode_envelope(&envelope)
}

/// Extract the embedded `.excalidraw` JSON from a PNG that carries an
/// Excalidraw `tEXt` chunk (keyword = `application/vnd.excalidraw+json`).
pub fn extract_from_png(bytes: &[u8]) -> Result<String> {
    const PNG_SIG: &[u8] = b"\x89PNG\r\n\x1a\n";
    let body = bytes
        .strip_prefix(PNG_SIG)
        .ok_or_else(|| anyhow!("not a PNG (missing 8-byte signature)"))?;

    const KEYWORD: &[u8] = b"application/vnd.excalidraw+json";
    let mut cur = body;
    loop {
        if cur.len() < 12 {
            bail!(
                "PNG does not contain an embedded Excalidraw scene \
                 (no tEXt chunk with keyword `application/vnd.excalidraw+json`). \
                 excalidraw-image only extracts PNGs that include the scene."
            );
        }
        let len = u32::from_be_bytes([cur[0], cur[1], cur[2], cur[3]]) as usize;
        let chunk_type = &cur[4..8];
        let data_end = 8 + len;
        if cur.len() < data_end + 4 {
            bail!("PNG chunk is truncated");
        }
        let data = &cur[8..data_end];
        if chunk_type == b"tEXt" {
            // tEXt: keyword \x00 text. Latin-1 text per PNG spec.
            if let Some(sep) = data.iter().position(|&b| b == 0) {
                if &data[..sep] == KEYWORD {
                    let envelope = latin1_to_string(&data[sep + 1..]);
                    return decode_envelope(&envelope);
                }
            }
        }
        // Stop at IEND for a tighter error than running off the end.
        if chunk_type == b"IEND" {
            bail!(
                "PNG does not contain an embedded Excalidraw scene \
                 (reached IEND without a `application/vnd.excalidraw+json` tEXt chunk)."
            );
        }
        cur = &cur[data_end + 4..]; // +4 CRC
    }
}

fn parse_payload_version(svg: &str) -> u32 {
    // Format: `<!-- payload-version:N -->`. Treat anything we can't parse as 1.
    const PAT: &str = "<!-- payload-version:";
    let Some(i) = svg.find(PAT) else { return 1 };
    let tail = &svg[i + PAT.len()..];
    let end = tail.find(" -->").unwrap_or(tail.len());
    tail[..end].trim().parse().unwrap_or(1)
}

/// Convert a latin-1 (one-byte-per-codepoint) byte slice into a Rust `String`.
/// Each byte `b` becomes the codepoint `U+00bb`, which then UTF-8-encodes
/// cleanly. Used for: (a) the SVG v2 envelope (base64-decoded latin-1 JSON)
/// and (b) the PNG tEXt envelope.
fn latin1_to_string(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len());
    for &b in bytes {
        s.push(b as char);
    }
    s
}

#[derive(serde::Deserialize)]
struct Envelope {
    /// `"bstring"` is the only encoding Excalidraw has ever shipped.
    #[serde(default)]
    encoding: Option<String>,
    /// True when `encoded` is a deflated byte stream; false when it's the
    /// raw UTF-8 bytes of the original text packed as a bstring.
    #[serde(default)]
    compressed: bool,
    /// The bstring. Each `char` of this `String` represents one byte
    /// (`char as u8`).
    encoded: Option<String>,
    /// Older "self-describing" payloads put the scene at the top level
    /// instead of behind `encoded`. We pass those through as-is.
    #[serde(rename = "type", default)]
    type_: Option<String>,
}

fn decode_envelope(json: &str) -> Result<String> {
    let env: Envelope = serde_json::from_str(json).context("envelope JSON is malformed")?;

    // Older format: `{ "type": "excalidraw", ... }` — the JSON IS the scene.
    // Excalidraw's own decoder (`mp` in the bundle) handles this branch too.
    if env.encoded.is_none() {
        if env.type_.as_deref() == Some("excalidraw") {
            return Ok(json.to_string());
        }
        bail!("envelope is missing `encoded` and is not a self-describing scene");
    }

    let encoding = env.encoding.as_deref().unwrap_or("bstring");
    if encoding != "bstring" {
        bail!("unsupported envelope encoding `{encoding}` (expected `bstring`)");
    }

    let bytes = bstring_to_bytes(env.encoded.as_deref().unwrap());

    let scene = if env.compressed {
        let mut z = ZlibDecoder::new(&bytes[..]);
        let mut out = String::new();
        z.read_to_string(&mut out)
            .context("failed to inflate compressed scene payload")?;
        out
    } else {
        String::from_utf8(bytes).context("uncompressed scene payload is not valid UTF-8")?
    };

    Ok(scene)
}

fn bstring_to_bytes(s: &str) -> Vec<u8> {
    s.chars().map(|c| c as u8).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sniff_excalidraw_json() {
        assert_eq!(
            sniff(b"{\"type\":\"excalidraw\"}").unwrap(),
            InputKind::Excalidraw
        );
        // BOM-prefixed JSON also identifies as Excalidraw.
        let mut bom = vec![0xEF, 0xBB, 0xBF];
        bom.extend_from_slice(b"\n  {\"type\":\"x\"}");
        assert_eq!(sniff(&bom).unwrap(), InputKind::Excalidraw);
    }

    #[test]
    fn sniff_svg() {
        assert_eq!(sniff(b"<svg></svg>").unwrap(), InputKind::Svg);
        assert_eq!(
            sniff(b"<?xml version=\"1.0\"?><svg/>").unwrap(),
            InputKind::Svg
        );
    }

    #[test]
    fn sniff_png() {
        assert_eq!(sniff(b"\x89PNG\r\n\x1a\n\x00\x00").unwrap(), InputKind::Png);
    }

    #[test]
    fn sniff_unknown() {
        assert!(sniff(b"GIF89a").is_err());
        assert!(sniff(b"").is_err());
    }

    #[test]
    fn parse_payload_version_default_when_missing() {
        assert_eq!(parse_payload_version("<svg></svg>"), 1);
    }

    #[test]
    fn parse_payload_version_v2() {
        let svg = "<!-- payload-version:2 -->";
        assert_eq!(parse_payload_version(svg), 2);
    }

    #[test]
    fn extract_from_svg_missing_marker() {
        let err = extract_from_svg("<svg></svg>").unwrap_err();
        assert!(err.to_string().contains("does not contain"), "{err}");
    }

    #[test]
    fn extract_from_png_missing_chunk() {
        // Minimal PNG: signature + IHDR + IEND, no tEXt.
        let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
        // IHDR (length 13, type "IHDR", 13 zero bytes for body, fake CRC).
        png.extend_from_slice(&13u32.to_be_bytes());
        png.extend_from_slice(b"IHDR");
        png.extend_from_slice(&[0; 13]);
        png.extend_from_slice(&[0; 4]);
        // IEND (length 0, type "IEND", no body, fake CRC).
        png.extend_from_slice(&0u32.to_be_bytes());
        png.extend_from_slice(b"IEND");
        png.extend_from_slice(&[0; 4]);

        let err = extract_from_png(&png).unwrap_err();
        assert!(err.to_string().contains("does not contain"), "{err}");
    }

    #[test]
    fn extract_from_svg_round_trips_uncompressed() {
        // Build an envelope by hand for the v2 carrier. Uncompressed path:
        // `encoded` is the bstring of the original JSON's UTF-8 bytes.
        let scene = r#"{"type":"excalidraw","version":2,"elements":[]}"#;
        let encoded: String = scene.bytes().map(|b| b as char).collect();
        let envelope = serde_json::json!({
            "version": "1",
            "encoding": "bstring",
            "compressed": false,
            "encoded": encoded,
        })
        .to_string();
        // v2 carrier: btoa(envelope) — i.e., latin-1(envelope) → base64.
        let envelope_bytes: Vec<u8> = envelope.chars().map(|c| c as u8).collect();
        let b64 = B64.encode(envelope_bytes);
        let svg = format!(
            "<svg><metadata>\
             <!-- payload-type:application/vnd.excalidraw+json -->\
             <!-- payload-version:2 -->\
             <!-- payload-start -->{b64}<!-- payload-end --></metadata></svg>"
        );

        let got = extract_from_svg(&svg).unwrap();
        assert_eq!(got, scene);
    }

    #[test]
    fn extract_from_svg_round_trips_compressed() {
        use flate2::write::ZlibEncoder;
        use flate2::Compression;
        use std::io::Write;
        let scene = r#"{"type":"excalidraw","version":2,"elements":[{"id":"a"}]}"#;

        let mut z = ZlibEncoder::new(Vec::new(), Compression::default());
        z.write_all(scene.as_bytes()).unwrap();
        let deflated = z.finish().unwrap();

        let encoded: String = deflated.iter().map(|&b| b as char).collect();
        let envelope = serde_json::json!({
            "version": "1",
            "encoding": "bstring",
            "compressed": true,
            "encoded": encoded,
        })
        .to_string();
        let envelope_bytes: Vec<u8> = envelope.chars().map(|c| c as u8).collect();
        let b64 = B64.encode(envelope_bytes);
        let svg = format!(
            "<svg><metadata>\
             <!-- payload-type:application/vnd.excalidraw+json -->\
             <!-- payload-version:2 -->\
             <!-- payload-start -->{b64}<!-- payload-end --></metadata></svg>"
        );

        let got = extract_from_svg(&svg).unwrap();
        assert_eq!(got, scene);
    }

    #[test]
    fn extract_from_png_round_trips_compressed() {
        use flate2::write::ZlibEncoder;
        use flate2::Compression;
        use std::io::Write;
        let scene = r#"{"type":"excalidraw","elements":[{"id":"x"}]}"#;
        let mut z = ZlibEncoder::new(Vec::new(), Compression::default());
        z.write_all(scene.as_bytes()).unwrap();
        let deflated = z.finish().unwrap();
        let encoded: String = deflated.iter().map(|&b| b as char).collect();
        let envelope = serde_json::json!({
            "version": "1",
            "encoding": "bstring",
            "compressed": true,
            "encoded": encoded,
        })
        .to_string();
        let envelope_bytes: Vec<u8> = envelope.chars().map(|c| c as u8).collect();

        // Hand-build a PNG: signature + (fake) IHDR + tEXt + IEND. CRCs are
        // not validated by the extractor, so zeros are fine.
        let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
        png.extend_from_slice(&13u32.to_be_bytes());
        png.extend_from_slice(b"IHDR");
        png.extend_from_slice(&[0; 13]);
        png.extend_from_slice(&[0; 4]);

        let mut tdata = b"application/vnd.excalidraw+json\x00".to_vec();
        tdata.extend_from_slice(&envelope_bytes);
        png.extend_from_slice(&(tdata.len() as u32).to_be_bytes());
        png.extend_from_slice(b"tEXt");
        png.extend_from_slice(&tdata);
        png.extend_from_slice(&[0; 4]);

        png.extend_from_slice(&0u32.to_be_bytes());
        png.extend_from_slice(b"IEND");
        png.extend_from_slice(&[0; 4]);

        let got = extract_from_png(&png).unwrap();
        assert_eq!(got, scene);
    }
}
