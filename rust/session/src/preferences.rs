use serde_json::{Map, Value, json};

/// Match the preference portion of TS projectSessionHostState. This never
/// installs a permission mode or projects Harness/Skill migration identities.
pub(super) fn project(records: &[Value]) -> Value {
    let mut state = Map::new();
    for record in records {
        let Some(metadata) = record.get("metadata").and_then(Value::as_object) else {
            continue;
        };
        for (key, allowed) in [
            (
                "engine",
                &[
                    "etl",
                    "runtime",
                    "evaluate",
                    "weaver",
                    "weaver-orch",
                    "dyad",
                    "stage",
                ][..],
            ),
            (
                "permissionMode",
                &["MANUAL", "INERTIA", "MOMENTUM", "YOLO"][..],
            ),
        ] {
            if let Some(value) = metadata
                .get(key)
                .and_then(Value::as_str)
                .filter(|value| allowed.contains(value))
            {
                state.insert(key.into(), json!(value));
            }
        }
        for (key, allowed) in [
            (
                "reasoningTier",
                &["off", "low", "medium", "high", "xhigh", "max"][..],
            ),
            (
                "reasoningDisplayMode",
                &["hidden", "collapsed", "expanded"][..],
            ),
        ] {
            if let Some(value) = metadata.get(key) {
                if let Some(value) = value.as_str().filter(|value| allowed.contains(value)) {
                    state.insert(key.into(), json!(value));
                } else {
                    state.remove(key);
                }
            }
        }
        if let (Some(provider), Some(model)) = (
            metadata.get("providerId").and_then(Value::as_str),
            metadata.get("model").and_then(Value::as_str),
        ) {
            state.insert(
                "providerSelection".into(),
                json!({"provider": provider, "model": model}),
            );
        }
    }
    Value::Object(state)
}
