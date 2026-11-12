use std::collections::BTreeMap;
use std::time::Duration;

use rmcp::{
    ServiceError,
    model::{CallToolRequest, CallToolRequestParams, CallToolResponse},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::client::{self, Connection, Era};

async fn call(
    connection: &Connection,
    name: &str,
    arguments: Value,
) -> Result<rmcp::model::CallToolResult, &'static str> {
    let arguments = arguments
        .as_object()
        .ok_or("probe.invalid_arguments")?
        .clone();
    // One request only. Do not use the SDK's automatic multi-round tool helper.
    match connection
        .call_tool_once(CallToolRequestParams::new(name.to_owned()).with_arguments(arguments))
        .await
        .map_err(|_| "probe.call_failed")?
    {
        CallToolResponse::Complete(result) => Ok(result),
        _ => Err("probe.unsupported_result"),
    }
}

async fn fixture(connection: &Connection) -> Result<Value, &'static str> {
    let tools = connection
        .list_tools(None)
        .await
        .map_err(|_| "probe.list_failed")?;
    let ok = call(connection, "probe", json!({})).await?;
    let tool_error = call(connection, "tool-error", json!({})).await?;
    let rpc_error = matches!(
        connection
            .call_tool_once(CallToolRequestParams::new("rpc-error"))
            .await,
        Err(ServiceError::McpError(_))
    );
    let pending = connection
        .send_cancellable_request(
            CallToolRequest::new(CallToolRequestParams::new("slow")).into(),
            Default::default(),
        )
        .await
        .map_err(|_| "probe.cancel_start_failed")?;
    tokio::time::sleep(Duration::from_millis(150)).await;
    pending
        .cancel(Some("bounded probe".into()))
        .await
        .map_err(|_| "probe.cancel_failed")?;
    connection
        .list_tools(None)
        .await
        .map_err(|_| "probe.post_cancel_list_failed")?;
    // The independent fixture verifies the bound cancellation id and exactly
    // one execution of the cancelled request.
    if ok.is_error == Some(true) || tool_error.is_error != Some(true) || !rpc_error {
        return Err("probe.fixture_mismatch");
    }
    Ok(
        json!({"tools": tools.tools.iter().map(|tool| tool.name.as_ref()).collect::<Vec<_>>(), "content": ok.content, "toolError": true, "rpcError": true, "cancelled": true}),
    )
}

pub async fn fixtures(legacy_url: &str, modern_url: &str) -> Result<Value, &'static str> {
    let legacy = client::connect(legacy_url, &BTreeMap::new(), Era::Legacy, false).await?;
    let modern = match client::connect(modern_url, &BTreeMap::new(), Era::Modern, false).await {
        Ok(connection) => connection,
        Err(error) => {
            let _ = client::close(legacy).await;
            return Err(error);
        }
    };
    // Both connections stay alive while independently routed calls execute.
    let result: Result<Value, &'static str> =
        async { Ok(json!({"legacy": fixture(&legacy).await?, "modern": fixture(&modern).await?})) }
            .await;
    let legacy_closed = client::close(legacy).await;
    let modern_closed = client::close(modern).await;
    let result: Value = result?;
    legacy_closed?;
    modern_closed?;
    Ok(result)
}

pub async fn live(
    url: &str,
    headers: &BTreeMap<String, String>,
    era: Era,
) -> Result<Value, &'static str> {
    let connection = client::connect(url, headers, era, true).await?;
    let result = async {
        let list = connection.list_tools(None).await.map_err(|_| "probe.list_failed")?;
        if !list.tools.iter().any(|tool| tool.name == "list_items") { return Err("probe.readonly_tool_missing"); }
        // Owner-authorized PRTS read-only lane. No arbitrary tool dispatch.
        let result = call(&connection, "list_items", json!({"limit": 1})).await?;
        if result.is_error == Some(true) || result.content.is_empty() { return Err("probe.live_result_failed"); }
        let bytes = serde_json::to_vec(&result.content).map_err(|_| "probe.result_invalid")?;
        if bytes.len() > 64 * 1024 { return Err("probe.live_output_limit"); }
        let digest = Sha256::digest(&bytes).iter().map(|byte| format!("{byte:02x}")).collect::<String>();
        Ok(json!({"toolCount": list.tools.len(), "protocolVersion": connection.peer_info().map(|info| info.protocol_version.to_string()), "tool": "list_items", "contentBytes": bytes.len(), "contentSha256": digest, "isError": false}))
    }.await;
    let closed = client::close(connection).await;
    let result = result?;
    closed?;
    Ok(result)
}
