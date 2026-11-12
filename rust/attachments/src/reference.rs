use serde_json::Value;

use crate::{Error, MAX_FILE_BYTES};

pub(super) struct Reference<'a> {
    pub path: &'a str,
    pub hash: &'a str,
    pub bytes: u64,
    pub media_type: &'a str,
}

pub(super) fn parse(value: &Value) -> Result<Reference<'_>, Error> {
    let invalid = || Error::new("attachment.invalid_reference");
    let reference = value.as_object().ok_or_else(invalid)?;
    if reference.contains_key("data") {
        return Err(Error::new("attachment.inline_data_unsupported"));
    }
    if reference
        .get("id")
        .and_then(Value::as_str)
        .is_none_or(str::is_empty)
        || !matches!(
            reference.get("source").and_then(Value::as_str),
            Some("clipboard" | "project" | "mcp")
        )
    {
        return Err(invalid());
    }
    let hash = reference
        .get("sha256")
        .and_then(Value::as_str)
        .ok_or_else(invalid)?;
    if hash.len() != 64
        || !hash
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    {
        return Err(invalid());
    }
    let media_type = reference
        .get("mediaType")
        .and_then(Value::as_str)
        .ok_or_else(invalid)?;
    let extension = match media_type {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        _ => return Err(invalid()),
    };
    let path = reference
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(invalid)?;
    if path != format!(".vesicle/attachments/{hash}.{extension}") {
        return Err(Error::new("attachment.unsafe_path"));
    }
    let bytes = reference
        .get("bytes")
        .and_then(Value::as_f64)
        .ok_or_else(invalid)?;
    if !bytes.is_finite() || bytes.fract() != 0.0 || bytes <= 0.0 || bytes > MAX_FILE_BYTES as f64 {
        return Err(Error::new("attachment.size_limit"));
    }
    Ok(Reference {
        path,
        hash,
        bytes: bytes as u64,
        media_type,
    })
}

pub(super) fn media_type(header: &[u8]) -> Option<&'static str> {
    if header.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if header.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if header.starts_with(b"GIF87a") || header.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if header.starts_with(b"RIFF") && header.get(8..12) == Some(b"WEBP") {
        Some("image/webp")
    } else {
        None
    }
}
