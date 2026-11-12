use std::ffi::OsStr;
use std::fs::{self, File};
use std::io::Read;

use vesicle_session::{InspectError, MAX_INPUT_BYTES};

pub(super) fn read(path: &OsStr, head: Option<&str>) -> Result<String, InspectError> {
    Ok(format!("{}\n", load(path, head)?))
}

pub(super) fn verify(
    project: &OsStr,
    path: &OsStr,
    head: Option<&str>,
) -> Result<String, InspectError> {
    let mut result = load(path, head)?;
    let report = vesicle_attachments::verify(
        std::path::Path::new(project),
        result["records"].as_array().expect("inspection records"),
    )
    .map_err(|error| InspectError {
        code: error.code,
        line: None,
    })?;
    result["attachmentsVerified"] = serde_json::Value::Bool(true);
    result["attachmentVerification"] = report;
    Ok(format!("{result}\n"))
}

fn load(path: &OsStr, head: Option<&str>) -> Result<serde_json::Value, InspectError> {
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
    vesicle_session::inspect(input, head)
}
