//! Bounded, read-only verification of content-addressed attachment references.
//! This checks a quiescent store, not an atomic capability against concurrent
//! directory replacement. It never materializes provider data or writes files.

mod reference;

use std::collections::HashMap;
use std::fs::{self, File, Metadata};
use std::io::Read;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};

pub const MAX_FILE_BYTES: u64 = 20 * 1024 * 1024;
pub const MAX_TOTAL_BYTES: u64 = 100 * 1024 * 1024;
pub const MAX_REFERENCES: usize = 1024;

#[derive(Debug)]
pub struct Error {
    pub code: &'static str,
}
impl Error {
    fn new(code: &'static str) -> Self {
        Self { code }
    }
}

/// Verify metadata.images across all physical records, including inactive
/// branches. Successful output reports unique files and actual verified bytes.
pub fn verify(project_root: &Path, records: &[Value]) -> Result<Value, Error> {
    let root =
        fs::canonicalize(project_root).map_err(|_| Error::new("attachment.invalid_project"))?;
    if !root.is_dir() {
        return Err(Error::new("attachment.invalid_project"));
    }
    let mut files = HashMap::new();
    let mut total = 0;
    let mut count = 0;
    for record in records {
        let Some(images) = record
            .get("metadata")
            .and_then(|metadata| metadata.get("images"))
        else {
            continue;
        };
        let images = images
            .as_array()
            .ok_or_else(|| Error::new("attachment.invalid_reference"))?;
        for image in images {
            count += 1;
            if count > MAX_REFERENCES {
                return Err(Error::new("attachment.reference_limit"));
            }
            let reference = reference::parse(image)?;
            if let Some(size) = files.get(reference.path) {
                if *size != reference.bytes {
                    return Err(Error::new("attachment.size_mismatch"));
                }
                continue;
            }
            if total + reference.bytes > MAX_TOTAL_BYTES {
                return Err(Error::new("attachment.total_limit"));
            }
            let path = checked_path(&root, reference.path)?;
            verify_file(&path, &reference, MAX_TOTAL_BYTES - total)?;
            // Reject persistent path changes during the read. This is still a
            // local inspection, not a race-free sandbox or restore authority.
            checked_path(&root, reference.path)?;
            files.insert(reference.path.to_owned(), reference.bytes);
            total += reference.bytes;
        }
    }
    Ok(json!({"references": count, "files": files.len(), "bytes": total}))
}

fn checked_path(root: &Path, relative: &str) -> Result<PathBuf, Error> {
    let mut path = root.to_owned();
    for (index, component) in relative.split('/').enumerate() {
        path.push(component);
        let metadata =
            fs::symlink_metadata(&path).map_err(|_| Error::new("attachment.read_failed"))?;
        if redirected(&metadata)
            || (index < 2 && !metadata.is_dir())
            || (index == 2 && !metadata.is_file())
        {
            return Err(Error::new("attachment.unsafe_path"));
        }
    }
    let resolved = fs::canonicalize(&path).map_err(|_| Error::new("attachment.read_failed"))?;
    if !resolved.starts_with(root) {
        return Err(Error::new("attachment.unsafe_path"));
    }
    Ok(path)
}

fn redirected(metadata: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0 // FILE_ATTRIBUTE_REPARSE_POINT
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

fn verify_file(
    path: &Path,
    reference: &reference::Reference<'_>,
    remaining: u64,
) -> Result<(), Error> {
    let file = File::open(path).map_err(|_| Error::new("attachment.read_failed"))?;
    let metadata = file
        .metadata()
        .map_err(|_| Error::new("attachment.read_failed"))?;
    if !metadata.is_file() {
        return Err(Error::new("attachment.unsafe_path"));
    }
    if metadata.len() != reference.bytes {
        return Err(Error::new("attachment.size_mismatch"));
    }
    let mut reader = file.take(MAX_FILE_BYTES.min(remaining) + 1);
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 65536];
    let mut header = Vec::with_capacity(12);
    let mut bytes = 0;
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|_| Error::new("attachment.read_failed"))?;
        if read == 0 {
            break;
        }
        bytes += read as u64;
        if bytes > MAX_FILE_BYTES || bytes > remaining {
            return Err(Error::new("attachment.size_limit"));
        }
        let header_bytes = (12 - header.len()).min(read);
        header.extend_from_slice(&buffer[..header_bytes]);
        digest.update(&buffer[..read]);
    }
    if bytes != reference.bytes {
        return Err(Error::new("attachment.size_mismatch"));
    }
    if digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()
        != reference.hash
    {
        return Err(Error::new("attachment.hash_mismatch"));
    }
    if reference::media_type(&header) != Some(reference.media_type) {
        return Err(Error::new("attachment.media_mismatch"));
    }
    Ok(())
}
