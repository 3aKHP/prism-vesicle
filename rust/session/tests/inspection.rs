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
        ("malformed-migration", "session.invalid_migration"),
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
fn migrated_identity_and_frozen_catalog_survive_older_branch_selection() {
    let input = fixture("migration-skill-host-state");
    let records: Vec<Value> = input
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    let result = inspect(&input, Some("r2")).unwrap();
    assert_eq!(
        contents(&result),
        ["pre-migration question", "pre-migration answer"]
    );
    assert_eq!(result["hostState"]["harness"]["packVersion"], "10.3.3");
    assert_eq!(
        result["hostState"]["skillCatalogSnapshot"]["entries"][0]["bodySha256"],
        "55258974a5d4a4391f9c1c0d840740aebc6e4d1ac870c58ebbb5ee955f1986b4"
    );
    assert_eq!(result["records"][0]["metadata"], records[0]["metadata"]);
    assert_eq!(result["records"][3]["metadata"], records[3]["metadata"]);
    let header = inspect(input.lines().next().unwrap(), None).unwrap();
    assert_eq!(header["hostState"]["harness"]["packVersion"], "10.3.2");
}

#[test]
fn required_migration_errors_fail_but_bad_optional_catalogs_do_not_erase_state() {
    let input = fixture("migration-skill-host-state");
    let records: Vec<Value> = input
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    for (field, invalid) in [
        ("from", json!({})),
        ("to", json!({})),
        ("archivePath", json!("")),
        (
            "preflight",
            json!({"verdict":"blocking","warningCount":0,"layers":[]}),
        ),
    ] {
        let mut changed = records.clone();
        changed[3]["metadata"]["migration"][field] = invalid;
        let changed = changed
            .iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n");
        assert_eq!(
            inspect(&changed, Some("r2")).unwrap_err().code,
            "session.invalid_migration",
            "{field}"
        );
    }
    let invalid = json!({"uuid":"bad-skills","parentUuid":"branch","sessionId":"fixture","ts":"now","role":"system","content":"","metadata":{"kind":"skill-catalog","skills":{"catalogHash":"bad","entries":[{"name":"x","scope":"invalid","bodySha256":"bad"}],"omittedCount":0,"diagnosticsCount":0}}});
    let result = inspect(&format!("{input}{invalid}\n"), Some("r2")).unwrap();
    assert_eq!(
        result["hostState"]["skillCatalogSnapshot"]["catalogHash"],
        "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
    );
    assert_eq!(
        result["records"].as_array().unwrap().last().unwrap()["metadata"]["skills"]["catalogHash"],
        "bad"
    );
}

#[test]
fn header_identity_rejects_unknown_fields_and_invalid_persisted_patterns() {
    let original: Value = serde_json::from_str(
        fixture("migration-skill-host-state")
            .lines()
            .next()
            .unwrap(),
    )
    .unwrap();
    for (field, value) in [
        ("unknown", json!("x")),
        ("packId", json!("../pack")),
        ("packVersion", json!("1.2")),
        ("manifestSha256", json!("A".repeat(64))),
    ] {
        let mut record = original.clone();
        record["metadata"]["harness"][field] = value;
        assert_eq!(
            inspect(&record.to_string(), None).unwrap_err().code,
            "session.invalid_harness_identity"
        );
    }
    let mut record = original;
    record["metadata"]["harness"]["packVersion"] = json!("01.2.3-rc.1");
    assert!(
        inspect(&record.to_string(), None).is_ok(),
        "persisted TS pattern allows leading zeroes"
    );
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

#[test]
fn literal_serializer_tags_remain_objects_in_metadata_and_provider_payloads() {
    let opaque = json!({"$serde_json::private::Number":"123","other":[{"$serde_json::private::RawValue":"false"}]});
    let mut record: Value =
        serde_json::from_str(fixture("legacy-linear").lines().last().unwrap()).unwrap();
    record["metadata"]["providerState"]["payload"] = opaque.clone();
    record["metadata"]["opaque"] = json!({"$serde_json::private::Number":"123"});
    let result = inspect(&record.to_string(), None).unwrap();
    assert_eq!(
        result["records"][0]["metadata"]["providerState"]["payload"],
        opaque
    );
    assert_eq!(
        result["activeBranch"][0]["metadata"]["opaque"],
        json!({"$serde_json::private::Number":"123"})
    );
}

#[test]
fn candidate_markers_require_a_content_leaf_and_its_owning_user_turn() {
    for (leaf, fork) in [
        (Value::Null, json!("missing")),
        (json!("a2"), json!("missing")),
        (json!("a2"), json!("u1")),
        (json!("s"), json!("u1")),
    ] {
        let marker = json!({"uuid":"select","parentUuid":leaf,"sessionId":"fixture","ts":"now","role":"system","content":"","metadata":{"kind":"candidate-selection","forkPointUuid":fork,"selectedLeafUuid":leaf}});
        let input = format!("{}{marker}\n", fixture("nested-candidates"));
        assert_eq!(
            inspect(&input, None).unwrap_err().code,
            "session.invalid_selection"
        );
    }
}
