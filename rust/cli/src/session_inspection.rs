use std::ffi::OsStr;
use std::fs::{self, File};
use std::io::Read;

use vesicle_session::{InspectError, MAX_INPUT_BYTES};

pub(super) fn read(path: &OsStr, head: Option<&str>) -> Result<String, InspectError> {
    let failure = |code| InspectError { code, line: None };
    // This explicit developer command accepts host paths. It is not a
    // model-visible filesystem tool and does not claim a project path guard.
    let metadata = fs::metadata(path).map_err(|_| failure("session.read_failed"))?;
    if !metadata.is_file() {
        return Err(failure("session.regular_file_required"));
    }
    let file = File::open(path).map_err(|_| failure("session.read_failed"))?;
    let mut bytes = Vec::new();
    file.take((MAX_INPUT_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| failure("session.read_failed"))?;
    if bytes.len() > MAX_INPUT_BYTES {
        return Err(failure("session.input_too_large"));
    }
    let input = std::str::from_utf8(&bytes).map_err(|_| failure("session.invalid_utf8"))?;
    let result = vesicle_session::inspect(input, head)?;
    Ok(format!("{result}\n"))
}
