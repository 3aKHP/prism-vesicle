use serde_json::Value;

use crate::InspectError;

pub(super) fn validate(value: &Value) -> Result<(), InspectError> {
    let invalid = || InspectError::new("session.invalid_harness_identity");
    let object = value.as_object().ok_or_else(invalid)?;
    let fields = [
        "packId",
        "packVersion",
        "sourceCommit",
        "manifestSha256",
        "adapterId",
        "adapterVersion",
        "adapterHash",
    ];
    if object.len() != fields.len()
        || fields.iter().any(|key| {
            object
                .get(*key)
                .and_then(Value::as_str)
                .is_none_or(str::is_empty)
        })
    {
        return Err(invalid());
    }
    let pack_id = object["packId"].as_str().expect("validated string");
    if !pack_id.as_bytes()[0].is_ascii_lowercase()
        || !pack_id
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
        || !version(object["packVersion"].as_str().expect("validated string"))
        || !version(object["adapterVersion"].as_str().expect("validated string"))
        || !hash(&object["manifestSha256"])
        || !hash(&object["adapterHash"])
    {
        return Err(invalid());
    }
    Ok(())
}

pub(super) fn hash(value: &Value) -> bool {
    value.as_str().is_some_and(|value| {
        value.len() == 64
            && value
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    })
}

// Match the persisted Harness pattern, not a stricter SemVer interpretation:
// ^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$
fn version(value: &str) -> bool {
    let suffix = value.find(['-', '+']);
    let core = suffix.map_or(value, |position| &value[..position]);
    let parts: Vec<_> = core.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.bytes().all(|c| c.is_ascii_digit()))
        && suffix.is_none_or(|position| {
            let suffix = &value[position + 1..];
            !suffix.is_empty()
                && suffix
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'.' || c == b'-')
        })
}
