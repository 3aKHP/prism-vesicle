use std::collections::BTreeMap;

use serde_json::{Value, value::RawValue};

use crate::InspectError;

/// With arbitrary_precision, Value's generic map visitor interprets a literal
/// `$serde_json::private::Number` key as an internal numeric token. Decode
/// containers as raw children so opaque objects cannot collide with that tag;
/// only JSON primitives enter Value's deserializer.
pub(super) fn parse(text: &str, depth: usize) -> Result<Value, InspectError> {
    let invalid = || InspectError::new("session.invalid_json");
    if depth >= 128 {
        return Err(invalid());
    }
    match text.trim_start().as_bytes().first() {
        Some(b'{') => {
            let fields: BTreeMap<String, &RawValue> =
                serde_json::from_str(text).map_err(|_| invalid())?;
            let fields = fields
                .into_iter()
                .map(|(key, value)| Ok((key, parse(value.get(), depth + 1)?)))
                .collect::<Result<_, InspectError>>()?;
            Ok(Value::Object(fields))
        }
        Some(b'[') => {
            let items: Vec<&RawValue> = serde_json::from_str(text).map_err(|_| invalid())?;
            let items = items
                .into_iter()
                .map(|value| parse(value.get(), depth + 1))
                .collect::<Result<_, _>>()?;
            Ok(Value::Array(items))
        }
        _ => serde_json::from_str(text).map_err(|_| invalid()),
    }
}
