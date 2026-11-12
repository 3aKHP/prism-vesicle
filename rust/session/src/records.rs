use std::collections::HashMap;

use serde_json::{Value, json};

use crate::{InspectError, provider_state};

pub(super) fn parse(input: &str) -> Result<Vec<Value>, InspectError> {
    let mut records = Vec::new();
    let mut ids = HashMap::new();
    let mut session_id = None;
    let mut previous = Value::Null;
    for (line, text) in input.lines().enumerate() {
        if text.trim().is_empty() {
            continue;
        }
        let record =
            normalize(text, records.len(), &previous, &mut session_id).map_err(|mut error| {
                error.line = Some(line + 1);
                error
            })?;
        let uuid = record["uuid"].as_str().expect("normalized UUID");
        if ids.contains_key(uuid) {
            return Err(InspectError {
                code: "session.duplicate_uuid",
                line: Some(line + 1),
            });
        }
        // Append-only links point backward. Reject unsupported forward links as
        // well as missing parents/cycles, even on an unselected branch.
        if let Some(parent) = record["parentUuid"].as_str()
            && !ids.contains_key(parent)
        {
            return Err(InspectError {
                code: "session.invalid_parent",
                line: Some(line + 1),
            });
        }
        validate_selection(&record, &records, &ids).map_err(|mut error| {
            error.line = Some(line + 1);
            error
        })?;
        ids.insert(uuid.to_owned(), records.len());
        previous = record["uuid"].clone();
        records.push(record);
    }
    if records.is_empty() {
        return Err(InspectError::new("session.empty"));
    }
    Ok(records)
}

fn normalize(
    text: &str,
    index: usize,
    previous: &Value,
    session_id: &mut Option<String>,
) -> Result<Value, InspectError> {
    let mut value = crate::json::parse(text, 0)?;
    let record = value
        .as_object_mut()
        .ok_or_else(|| InspectError::new("session.invalid_record"))?;
    let id = record
        .get("sessionId")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| InspectError::new("session.invalid_record"))?
        .to_owned();
    if session_id.as_ref().is_some_and(|expected| expected != &id) {
        return Err(InspectError::new("session.mixed_identity"));
    }
    *session_id = Some(id.clone());
    if !record.get("ts").is_some_and(Value::is_string)
        || !record.get("content").is_some_and(Value::is_string)
        || !matches!(
            record.get("role").and_then(Value::as_str),
            Some("system" | "user" | "assistant" | "tool")
        )
    {
        return Err(InspectError::new("session.invalid_record"));
    }
    match record.get("uuid") {
        None => {
            record.insert("uuid".into(), json!(format!("{id}:legacy:{index}")));
        }
        Some(Value::String(uuid)) if uuid.is_empty() => {
            record.insert("uuid".into(), json!(format!("{id}:legacy:{index}")));
        }
        Some(Value::String(_)) => {}
        _ => return Err(InspectError::new("session.invalid_record")),
    }
    match record.get("parentUuid") {
        None => {
            record.insert("parentUuid".into(), previous.clone());
        }
        Some(Value::Null) => {}
        Some(Value::String(parent)) if !parent.is_empty() => {}
        _ => return Err(InspectError::new("session.invalid_parent")),
    }
    if record["role"] == "tool" {
        return Err(InspectError::new("session.unsupported_tool_history"));
    }
    if let Some(metadata) = record.get("metadata") {
        let metadata = metadata
            .as_object()
            .ok_or_else(|| InspectError::new("session.invalid_metadata"))?;
        if metadata.contains_key("toolCalls") {
            return Err(InspectError::new("session.unsupported_tool_history"));
        }
        if let Some(kind) = metadata.get("kind") {
            if record["role"] != "system"
                || !matches!(
                    kind.as_str(),
                    Some(
                        "candidate-selection"
                            | "provider-switch"
                            | "engine-switch"
                            | "thinking-switch"
                            | "reasoning-switch"
                            | "permission-mode-switch"
                    )
                )
            {
                return Err(InspectError::new("session.unsupported_kind"));
            }
            if kind == "candidate-selection"
                && (metadata
                    .get("forkPointUuid")
                    .and_then(Value::as_str)
                    .is_none_or(|id| id.is_empty())
                    || metadata
                        .get("selectedLeafUuid")
                        .and_then(Value::as_str)
                        .is_none_or(|id| id.is_empty())
                    || metadata.get("selectedLeafUuid") != record.get("parentUuid"))
            {
                return Err(InspectError::new("session.invalid_selection"));
            }
        }
        if let Some(state) = metadata.get("providerState") {
            provider_state::validate(state)?;
        }
    }
    Ok(value)
}

fn validate_selection(
    record: &Value,
    records: &[Value],
    ids: &HashMap<String, usize>,
) -> Result<(), InspectError> {
    if record["metadata"]["kind"] != "candidate-selection" {
        return Ok(());
    }
    let invalid = || InspectError::new("session.invalid_selection");
    let mut cursor = record["parentUuid"].as_str().ok_or_else(invalid)?;
    let leaf = &records[*ids.get(cursor).ok_or_else(invalid)?];
    if leaf["role"] == "system" {
        return Err(invalid());
    }
    loop {
        let ancestor = &records[*ids.get(cursor).ok_or_else(invalid)?];
        if ancestor["role"] == "user" {
            return if ancestor["uuid"] == record["metadata"]["forkPointUuid"] {
                Ok(())
            } else {
                Err(invalid())
            };
        }
        cursor = ancestor["parentUuid"].as_str().ok_or_else(invalid)?;
    }
}

pub(super) fn branch(records: &[Value], head: Option<&str>) -> Result<Vec<Value>, InspectError> {
    let by_id: HashMap<&str, &Value> = records
        .iter()
        .map(|record| (record["uuid"].as_str().expect("normalized UUID"), record))
        .collect();
    let mut cursor = head.or_else(|| records.last().and_then(|record| record["uuid"].as_str()));
    let mut selected = Vec::new();
    while let Some(uuid) = cursor {
        let record = by_id
            .get(uuid)
            .ok_or_else(|| InspectError::new("session.head_not_found"))?;
        selected.push((*record).clone());
        cursor = record["parentUuid"].as_str();
    }
    selected.reverse();
    Ok(selected)
}
