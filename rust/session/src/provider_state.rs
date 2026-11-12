use serde_json::Value;

use crate::InspectError;

// This is the shared durable envelope, not provider wire interpretation.
pub(super) fn validate(state: &Value) -> Result<(), InspectError> {
    let Some(object) = state.as_object() else {
        return Err(InspectError::new("session.invalid_provider_state"));
    };
    if object.get("version").and_then(Value::as_f64) != Some(1.0) {
        return Err(InspectError::new("session.unsupported_provider_state"));
    }
    let keys = [
        "version",
        "protocol",
        "providerId",
        "model",
        "endpointFingerprint",
        "payload",
    ];
    if object.len() != keys.len() || object.keys().any(|key| !keys.contains(&key.as_str())) {
        return Err(InspectError::new("session.invalid_provider_state"));
    }
    for (key, limit) in [
        ("protocol", 128),
        ("providerId", 256),
        ("model", 256),
        ("endpointFingerprint", 512),
    ] {
        if !object[key]
            .as_str()
            .is_some_and(|value| !value.is_empty() && value.encode_utf16().count() <= limit)
        {
            return Err(InspectError::new("session.invalid_provider_state"));
        }
    }
    if !bounded_depth(&object["payload"], 0) || state.to_string().len() > 256 * 1024 {
        return Err(InspectError::new("session.invalid_provider_state"));
    }
    Ok(())
}

fn bounded_depth(value: &Value, depth: usize) -> bool {
    match value {
        Value::Array(items) => {
            depth < 64 && items.iter().all(|item| bounded_depth(item, depth + 1))
        }
        Value::Object(items) => {
            depth < 64 && items.values().all(|item| bounded_depth(item, depth + 1))
        }
        Value::Number(number) => number.as_f64().is_some_and(f64::is_finite),
        _ => true,
    }
}
