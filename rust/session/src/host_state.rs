use serde_json::{Value, json};

use crate::{InspectError, identity};

/// Effective identity and optional frozen catalog follow the physical stream,
/// independent of the selected conversation head. No installed assets or Skill
/// bodies are loaded or activated by this projection.
pub(super) fn project(records: &[Value], mut state: Value) -> Result<Value, InspectError> {
    let mut first_system = true;
    for record in records {
        let metadata = &record["metadata"];
        if record["role"] == "system" && first_system {
            first_system = false;
            if let Some(harness) = metadata.get("harness") {
                identity::validate(harness)?;
                state["harness"] = harness.clone();
            }
        }
        if record["role"] == "system" && metadata["kind"] == "session-migration" {
            // Validate the whole required envelope before rebinding any state.
            // The caller emits nothing until every physical record is valid.
            let target = migration_target(&metadata["migration"])?;
            state["harness"] = target.clone();
        }
        if let Some(snapshot) = skill_snapshot(&metadata["skills"]) {
            state["skillCatalogSnapshot"] = snapshot;
        }
    }
    Ok(state)
}

fn migration_target(value: &Value) -> Result<&Value, InspectError> {
    let invalid = || InspectError::new("session.invalid_migration");
    let object = value.as_object().ok_or_else(invalid)?;
    for key in ["migratedAt", "archivePath"] {
        if object
            .get(key)
            .and_then(Value::as_str)
            .is_none_or(str::is_empty)
        {
            return Err(invalid());
        }
    }
    let from = object.get("from").ok_or_else(invalid)?;
    if !from.is_null() {
        identity::validate(from).map_err(|_| invalid())?;
    }
    let target = object.get("to").ok_or_else(invalid)?;
    identity::validate(target).map_err(|_| invalid())?;
    let preflight = object
        .get("preflight")
        .and_then(Value::as_object)
        .ok_or_else(invalid)?;
    if !matches!(
        preflight.get("verdict").and_then(Value::as_str),
        Some("clean" | "warning")
    ) || !nonnegative_integer(preflight.get("warningCount"))
        || !preflight
            .get("layers")
            .and_then(Value::as_array)
            .is_some_and(|layers| {
                layers.iter().all(|layer| {
                    matches!(
                        layer.as_str(),
                        Some("resume" | "serializer" | "invariant" | "budget")
                    )
                })
            })
    {
        return Err(invalid());
    }
    Ok(target)
}

// Optional snapshot mismatches are ignored exactly as in the TS parser. A
// later malformed snapshot must not erase the last valid catalog identity.
fn skill_snapshot(value: &Value) -> Option<Value> {
    let source = value.as_object()?;
    let hash = source
        .get("catalogHash")?
        .as_str()
        .filter(|value| !value.is_empty())?;
    if !nonnegative_integer(source.get("omittedCount"))
        || !nonnegative_integer(source.get("diagnosticsCount"))
    {
        return None;
    }
    let mut entries = Vec::new();
    for entry in source.get("entries")?.as_array()? {
        let name = entry
            .get("name")?
            .as_str()
            .filter(|value| !value.is_empty())?;
        let scope = entry.get("scope")?.as_str()?;
        if !["harness", "user", "host", "project", "installed"].contains(&scope)
            || !identity::hash(&entry["bodySha256"])
        {
            return None;
        }
        entries.push(json!({"name": name, "scope": scope, "bodySha256": entry["bodySha256"]}));
    }
    Some(
        json!({"catalogHash": hash, "entries": entries, "omittedCount": source["omittedCount"], "diagnosticsCount": source["diagnosticsCount"]}),
    )
}

fn nonnegative_integer(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_f64)
        .is_some_and(|number| number.is_finite() && number >= 0.0 && number.fract() == 0.0)
}
