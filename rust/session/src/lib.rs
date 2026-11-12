//! Read-only inspection of a deliberately limited subset of durable JSONL.
//! This is not provider history, a resume operation, or file restoration.

mod json;
mod preferences;
mod provider_state;
mod records;

use serde_json::{Value, json};

pub const MAX_INPUT_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub struct InspectError {
    pub code: &'static str,
    pub line: Option<usize>,
}

impl InspectError {
    fn new(code: &'static str) -> Self {
        Self { code, line: None }
    }
}

/// Normalize legacy links, select an ancestor chain, and inspect physical-order
/// host preferences. Preserve metadata without interpreting provider payloads.
pub fn inspect(input: &str, head: Option<&str>) -> Result<Value, InspectError> {
    if input.len() > MAX_INPUT_BYTES {
        return Err(InspectError::new("session.input_too_large"));
    }
    let records = records::parse(input)?;
    let branch = records::branch(&records, head)?;
    let preferences = preferences::project(&records);
    Ok(json!({
        "schemaVersion": 1,
        "mode": "read-only-inspection",
        "attachmentsVerified": false,
        "records": records,
        "activeBranch": branch,
        "hostPreferences": preferences,
    }))
}
