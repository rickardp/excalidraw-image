// Embed an Excalidraw scene into an existing PNG so that re-opening the file
// on excalidraw.com round-trips back to the original drawing.
//
// PNG side mirrors what Excalidraw's exporter (`_p` in the prod bundle) does:
// inject a `tEXt` chunk with keyword `application/vnd.excalidraw+json` whose
// data is the JSON envelope (`{version,encoding:"bstring",compressed,encoded}`)
// in latin-1. The chunk is inserted just before `IEND` to mirror Excalidraw's
// own placement; PNG decoders accept tEXt anywhere between IHDR and IEND so
// the position is purely conventional.
//
// Also exposes `build_envelope_text(scene_json)` which the SVG `--editable`
// path uses to embed via the JS render's existing `exportEmbedScene` flag.
// (The SVG carrier path runs through Excalidraw's own `Si` / `Li`; we only
// need our own builder for the PNG side.)

use anyhow::{anyhow, bail, Result};
use flate2::write::ZlibEncoder;
use flate2::Compression;
use std::io::Write;

const PNG_SIG: &[u8] = b"\x89PNG\r\n\x1a\n";
const KEYWORD: &[u8] = b"application/vnd.excalidraw+json";

/// Insert a tEXt chunk carrying `scene_json` into `png` (just before IEND).
/// If a previous Excalidraw chunk already exists it is replaced. Returns the
/// new PNG bytes.
pub fn embed_scene_in_png(png: &[u8], scene_json: &str) -> Result<Vec<u8>> {
    let body = png
        .strip_prefix(PNG_SIG)
        .ok_or_else(|| anyhow!("not a PNG (missing 8-byte signature)"))?;

    // tEXt data: keyword \0 text. text is the envelope as latin-1 bytes.
    let envelope = build_envelope_bytes(scene_json)?;
    let mut text_data = Vec::with_capacity(KEYWORD.len() + 1 + envelope.len());
    text_data.extend_from_slice(KEYWORD);
    text_data.push(0);
    text_data.extend_from_slice(&envelope);

    let new_chunk = build_chunk(b"tEXt", &text_data);

    // Walk chunks. Drop any pre-existing Excalidraw tEXt; insert the new one
    // immediately before IEND.
    let mut out = Vec::with_capacity(png.len() + new_chunk.len());
    out.extend_from_slice(PNG_SIG);

    let mut cur = body;
    let mut inserted = false;
    loop {
        if cur.len() < 12 {
            bail!("PNG truncated (chunk header would not fit)");
        }
        let len = u32::from_be_bytes([cur[0], cur[1], cur[2], cur[3]]) as usize;
        let chunk_type = &cur[4..8];
        let total = 8 + len + 4; // length+type+data+crc
        if cur.len() < total {
            bail!("PNG chunk is truncated (declared {len} bytes, but only {} remain)", cur.len() - 8);
        }
        let chunk = &cur[..total];

        if chunk_type == b"tEXt" && is_excalidraw_text_chunk(&cur[8..8 + len]) {
            // Drop the existing Excalidraw chunk; we'll write the new one.
            cur = &cur[total..];
            continue;
        }

        if chunk_type == b"IEND" && !inserted {
            out.extend_from_slice(&new_chunk);
            inserted = true;
        }

        out.extend_from_slice(chunk);
        cur = &cur[total..];

        if chunk_type == b"IEND" {
            break;
        }
    }

    if !inserted {
        bail!("PNG had no IEND chunk");
    }

    Ok(out)
}

fn is_excalidraw_text_chunk(data: &[u8]) -> bool {
    if let Some(sep) = data.iter().position(|&b| b == 0) {
        return &data[..sep] == KEYWORD;
    }
    false
}

fn build_chunk(chunk_type: &[u8; 4], data: &[u8]) -> Vec<u8> {
    let len = u32::try_from(data.len()).expect("chunk length fits in u32");
    let mut out = Vec::with_capacity(12 + data.len());
    out.extend_from_slice(&len.to_be_bytes());
    out.extend_from_slice(chunk_type);
    out.extend_from_slice(data);
    let mut hasher = crc32fast::Hasher::new();
    hasher.update(chunk_type);
    hasher.update(data);
    out.extend_from_slice(&hasher.finalize().to_be_bytes());
    out
}

/// Build the envelope JSON (matching Excalidraw's `Si`) with `compress:true`
/// and return its **latin-1** byte form — i.e. each char of the JSON string
/// down-cast to its low byte. This is what the PNG tEXt chunk holds, and what
/// `Di(..., true)` decodes on the JS side.
pub fn build_envelope_bytes(scene_json: &str) -> Result<Vec<u8>> {
    let mut z = ZlibEncoder::new(Vec::new(), Compression::default());
    z.write_all(scene_json.as_bytes())
        .map_err(|e| anyhow!("zlib write failed: {e}"))?;
    let deflated = z
        .finish()
        .map_err(|e| anyhow!("zlib finalize failed: {e}"))?;

    // bstring of `deflated`: each byte → JS string char with code = byte.
    let encoded: String = deflated.iter().map(|&b| b as char).collect();
    let envelope = serde_json::json!({
        "version": "1",
        "encoding": "bstring",
        "compressed": true,
        "encoded": encoded,
    })
    .to_string();

    // Now down-cast envelope chars to bytes (latin-1). Excalidraw's `Li(_, true)`
    // does `btoa(envelope)` which is exactly latin-1 → base64; the equivalent
    // for tEXt (which is latin-1 native) is just the char-to-byte cast.
    Ok(envelope.chars().map(|c| c as u8).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::extract;

    fn minimal_png() -> Vec<u8> {
        let mut png = PNG_SIG.to_vec();
        // IHDR (length 13, type "IHDR", 13 zero bytes for body, fake CRC).
        png.extend_from_slice(&13u32.to_be_bytes());
        png.extend_from_slice(b"IHDR");
        png.extend_from_slice(&[0; 13]);
        png.extend_from_slice(&[0; 4]);
        // IDAT (length 0, fake CRC).
        png.extend_from_slice(&0u32.to_be_bytes());
        png.extend_from_slice(b"IDAT");
        png.extend_from_slice(&[0; 4]);
        // IEND (length 0, type "IEND", no body, fake CRC).
        png.extend_from_slice(&0u32.to_be_bytes());
        png.extend_from_slice(b"IEND");
        png.extend_from_slice(&[0; 4]);
        png
    }

    #[test]
    fn embed_then_extract_round_trips() {
        let scene = r#"{"type":"excalidraw","version":2,"elements":[{"id":"r"}]}"#;
        let png = minimal_png();
        let with_scene = embed_scene_in_png(&png, scene).unwrap();
        let got = extract::extract_from_png(&with_scene).unwrap();
        assert_eq!(got, scene);
    }

    #[test]
    fn re_embedding_replaces_existing_chunk() {
        let scene1 = r#"{"type":"excalidraw","elements":[{"id":"a"}]}"#;
        let scene2 = r#"{"type":"excalidraw","elements":[{"id":"b"}]}"#;
        let png = minimal_png();
        let once = embed_scene_in_png(&png, scene1).unwrap();
        let twice = embed_scene_in_png(&once, scene2).unwrap();

        let got = extract::extract_from_png(&twice).unwrap();
        assert_eq!(got, scene2);

        // Sanity: only one tEXt chunk with our keyword in `twice`.
        let count = count_excalidraw_chunks(&twice);
        assert_eq!(count, 1, "expected exactly one Excalidraw tEXt chunk");
    }

    #[test]
    fn rejects_non_png() {
        let err = embed_scene_in_png(b"not a png", "{}").unwrap_err();
        assert!(err.to_string().contains("not a PNG"), "{err}");
    }

    fn count_excalidraw_chunks(png: &[u8]) -> usize {
        let body = &png[PNG_SIG.len()..];
        let mut cur = body;
        let mut count = 0;
        while cur.len() >= 12 {
            let len = u32::from_be_bytes([cur[0], cur[1], cur[2], cur[3]]) as usize;
            let chunk_type = &cur[4..8];
            if chunk_type == b"tEXt" && is_excalidraw_text_chunk(&cur[8..8 + len]) {
                count += 1;
            }
            if chunk_type == b"IEND" {
                break;
            }
            cur = &cur[8 + len + 4..];
        }
        count
    }
}
