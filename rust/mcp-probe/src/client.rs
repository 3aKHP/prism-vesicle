use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use rmcp::{
    ClientLifecycleMode, ClientServiceExt, RoleClient,
    model::{ClientConfig, ProtocolVersion},
    service::RunningService,
    transport::{
        StreamableHttpClientTransport, common::client_side_sse::NeverRetry,
        streamable_http_client::StreamableHttpClientTransportConfig,
    },
};

pub type Connection = RunningService<RoleClient, ClientConfig>;

#[derive(Clone, Copy)]
pub enum Era {
    Legacy,
    Modern,
}

impl Era {
    pub fn parse(value: &str) -> Result<Self, &'static str> {
        match value {
            "legacy" => Ok(Self::Legacy),
            "modern" => Ok(Self::Modern),
            _ => Err("probe.invalid_era"),
        }
    }
}

pub async fn connect(
    url: &str,
    headers: &BTreeMap<String, String>,
    era: Era,
    live: bool,
) -> Result<Connection, &'static str> {
    let parsed = reqwest::Url::parse(url).map_err(|_| "probe.invalid_url")?;
    if !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.fragment().is_some()
        || parsed.query().is_some()
    {
        return Err("probe.invalid_url");
    }
    if live {
        if parsed.scheme() != "https"
            || !headers
                .iter()
                .any(|(key, value)| key.eq_ignore_ascii_case("authorization") && !value.is_empty())
        {
            return Err("probe.authenticated_https_required");
        }
    } else if parsed.scheme() != "http"
        || parsed.host_str() != Some("127.0.0.1")
        || !headers.is_empty()
    {
        return Err("probe.loopback_required");
    }
    let mut request_headers = HeaderMap::new();
    for (name, value) in headers {
        let name = HeaderName::from_bytes(name.as_bytes()).map_err(|_| "probe.invalid_header")?;
        let mut value = HeaderValue::from_str(value).map_err(|_| "probe.invalid_header")?;
        value.set_sensitive(true);
        request_headers.insert(name, value);
    }
    let http = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(8))
        .default_headers(request_headers)
        .build()
        .map_err(|_| "probe.client_failed")?;
    let mut transport = StreamableHttpClientTransportConfig::with_uri(url.to_owned())
        .max_concurrent_requests(1)
        .control_request_timeout(Duration::from_secs(2))
        .max_sse_event_size(512 * 1024)
        .reinit_on_expired_session(false);
    transport.retry_config = Arc::new(NeverRetry::default());
    let transport = StreamableHttpClientTransport::with_client(http, transport);
    let lifecycle = match era {
        Era::Legacy => ClientLifecycleMode::Initialize,
        Era::Modern => ClientLifecycleMode::Discover {
            preferred_versions: vec![ProtocolVersion::V_2026_07_28],
        },
    };
    // Never use SDK Auto here: timeout-triggered legacy fallback is not the
    // Vesicle policy. Protocol errors also never cause a second connection.
    tokio::time::timeout(
        Duration::from_secs(10),
        ClientConfig::default()
            .with_protocol_version(ProtocolVersion::V_2025_03_26)
            .serve_with_lifecycle(transport, lifecycle),
    )
    .await
    .map_err(|_| "probe.connect_timeout")?
    .map_err(|_| "probe.connect_failed")
}

pub async fn close(connection: Connection) -> Result<(), &'static str> {
    tokio::time::timeout(Duration::from_secs(3), connection.cancel())
        .await
        .map_err(|_| "probe.close_timeout")?
        .map_err(|_| "probe.close_failed")?;
    Ok(())
}
