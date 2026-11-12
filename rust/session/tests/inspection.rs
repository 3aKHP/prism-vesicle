use serde_json::{Value, json};
use vesicle_session::inspect;

fn fixture(name: &str) -> String {
    std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/fixtures/migration/corpus")
            .join(name)
            .join("project/.vesicle/sessions/fixture.jsonl"),
    )
    .unwrap()
}

fn contents(result: &Value) -> Vec<&str> {
    result["activeBranch"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|record| record["role"] != "system")
        .map(|record| record["content"].as_str().unwrap())
        .collect()
}

#[test]
fn legacy_chain_preserves_opaque_state_and_record_metadata() {
    let result = inspect(&fixture("legacy-linear"), None).unwrap();
    assert_eq!(contents(&result), ["old question", "old answer"]);
    assert_eq!(result["records"][1]["parentUuid"], "fixture:legacy:0");
    assert_eq!(
        result["records"][2]["metadata"]["providerState"]["payload"]["encrypted"],
        "opaque\n+/=signature"
    );
}

#[test]
fn nested_heads_select_ancestry_not_physical_suffix() {
    let input = fixture("nested-candidates");
    assert_eq!(
        contents(&inspect(&input, None).unwrap()),
        ["outline", "beta", "expand beta", "beta two"]
    );
    assert_eq!(
        contents(&inspect(&input, Some("a2")).unwrap()),
        ["outline", "alpha", "expand alpha", "alpha two"]
    );
    assert_eq!(
        contents(&inspect(&input, Some("b1")).unwrap()),
        ["outline", "beta", "expand beta", "beta one"]
    );
    assert_eq!(
        inspect(&input, Some("absent")).unwrap_err().code,
        "session.head_not_found"
    );
}

#[test]
fn preferences_follow_physical_order_even_when_an_old_head_is_selected() {
    let mut input = fixture("nested-candidates");
    for record in [
        json!({"uuid":"p1","parentUuid":"b2","sessionId":"fixture","ts":"now","role":"system","content":"","metadata":{"kind":"provider-switch","providerId":"new","model":"new-model","reasoningTier":"high","permissionMode":"MANUAL"}}),
        json!({"uuid":"p2","parentUuid":"p1","sessionId":"fixture","ts":"now","role":"system","content":"","metadata":{"kind":"thinking-switch","reasoningTier":null,"reasoningDisplayMode":"expanded","engine":"weaver"}}),
    ] {
        input.push_str(&format!("{record}\n"));
    }
    let result = inspect(&input, Some("a1")).unwrap();
    assert_eq!(
        contents(&result),
        ["outline", "alpha", "expand alpha", "alpha one"]
    );
    assert_eq!(
        result["hostPreferences"],
        json!({"providerSelection":{"provider":"new","model":"new-model"},"permissionMode":"MANUAL","reasoningDisplayMode":"expanded","engine":"weaver"})
    );
    assert_eq!(result["records"].as_array().unwrap().len(), 12);
}

#[test]
fn selection_marker_and_attachment_references_are_retained() {
    let mut input = fixture("nested-candidates");
    input.push_str(&format!("{}\n",json!({"uuid":"select","parentUuid":"a2","sessionId":"fixture","ts":"now","role":"system","content":"","metadata":{"kind":"candidate-selection","forkPointUuid":"u2a","selectedLeafUuid":"a2"}})));
    assert_eq!(
        contents(&inspect(&input, None).unwrap()),
        ["outline", "alpha", "expand alpha", "alpha two"]
    );
    let input = fixture("attachment");
    let original: Vec<Value> = input
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    let result = inspect(&input, None).unwrap();
    assert_eq!(
        result["records"][1]["metadata"]["images"],
        original[1]["metadata"]["images"]
    );
    assert_eq!(result["attachmentsVerified"], false);
}

#[test]
fn unknown_formats_and_malformed_data_do_not_produce_partial_success() {
    assert_eq!(inspect("{", None).unwrap_err().code, "session.invalid_json");
    for (name, code) in [
        ("malformed-json", "session.invalid_record"),
        (
            "unsupported-provider-state",
            "session.unsupported_provider_state",
        ),
        ("compact-state", "session.unsupported_kind"),
        ("migration-skill-host-state", "session.unsupported_kind"),
        ("pending-gate", "session.unsupported_tool_history"),
    ] {
        assert_eq!(
            inspect(&fixture(name), None).unwrap_err().code,
            code,
            "{name}"
        );
    }
}

#[test]
fn invalid_graphs_are_rejected_even_outside_the_selected_branch() {
    let input = fixture("nested-candidates");
    let last = input.lines().last().unwrap();
    assert_eq!(
        inspect(&format!("{input}{last}\n"), Some("a1"))
            .unwrap_err()
            .code,
        "session.duplicate_uuid"
    );
    for parent in ["missing", "extra"] {
        let extra = json!({"uuid":"extra","parentUuid":parent,"sessionId":"fixture","ts":"now","role":"assistant","content":"orphan"});
        assert_eq!(
            inspect(&format!("{input}{extra}\n"), Some("a1"))
                .unwrap_err()
                .code,
            "session.invalid_parent"
        );
    }
}

#[test]
fn opaque_numbers_and_unicode_do_not_round_or_change() {
    let input = r#"{"sessionId":"s","ts":"now","role":"assistant","content":"中文👩🏽‍💻","metadata":{"opaque":1234567890123456789012345678901234567890}}"#;
    let result = inspect(input, None).unwrap();
    assert_eq!(
        result["records"][0]["metadata"]["opaque"].to_string(),
        "1234567890123456789012345678901234567890"
    );
    assert_eq!(result["records"][0]["content"], "中文👩🏽‍💻");
}

#[test]
fn malformed_or_unbounded_provider_envelopes_fail_without_interpreting_payloads() {
    let input = fixture("legacy-linear");
    let original: Vec<Value> = input
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    for defect in ["owner", "extra", "size", "depth", "nonfinite"] {
        let mut record = original[2].clone();
        let state = &mut record["metadata"]["providerState"];
        match defect {
            "owner" => {
                state["providerId"] = json!("");
            }
            "extra" => {
                state["unexpected"] = json!(true);
            }
            "size" => {
                state["payload"] = json!("x".repeat(256 * 1024));
            }
            "depth" => {
                let mut payload = json!(null);
                for _ in 0..65 {
                    payload = json!([payload]);
                }
                state["payload"] = payload;
            }
            "nonfinite" => {
                state["payload"] = serde_json::from_str("1e9999").unwrap();
            }
            _ => unreachable!(),
        }
        assert_eq!(
            inspect(&record.to_string(), None).unwrap_err().code,
            "session.invalid_provider_state",
            "{defect}"
        );
    }
    // JSON numeric spelling must not turn the supported version into an error.
    let mut record = original[2].clone();
    record["metadata"]["providerState"]["version"] = serde_json::from_str("1.0").unwrap();
    assert!(inspect(&record.to_string(), None).is_ok());
}
