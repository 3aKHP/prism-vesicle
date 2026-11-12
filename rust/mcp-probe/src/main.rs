//! Development-only MCP feasibility probe. It is not wired into the product.
mod client;
mod scenarios;

use std::collections::BTreeMap;
use std::io::{self, Read, Write};
use std::process::ExitCode;
use std::time::Duration;

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct LiveConfig {
    url: String,
    headers: BTreeMap<String, String>,
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> ExitCode {
    if rustls::crypto::ring::default_provider()
        .install_default()
        .is_err()
    {
        let _ = writeln!(
            io::stderr(),
            "{}",
            serde_json::json!({"error":"probe.tls_provider_failed"})
        );
        return ExitCode::FAILURE;
    }
    let args: Vec<_> = std::env::args().skip(1).collect();
    let result = tokio::time::timeout(Duration::from_secs(35), async {
        match args.as_slice() {
            [mode, legacy, modern] if mode == "fixtures" => scenarios::fixtures(legacy, modern).await,
            [mode, era] if mode == "live" => {
                let era = client::Era::parse(era)?;
                let mut input = Vec::new();
                io::stdin().take(16 * 1024 + 1).read_to_end(&mut input).map_err(|_| "probe.input_failed")?;
                if input.len() > 16 * 1024 { return Err("probe.input_limit"); }
                let config: LiveConfig = serde_json::from_slice(&input).map_err(|_| "probe.invalid_input")?;
                scenarios::live(&config.url, &config.headers, era).await
            }
            _ => Err("probe.usage: fixtures LEGACY_URL MODERN_URL | live legacy|modern (config on stdin)"),
        }
    }).await.unwrap_or(Err("probe.total_timeout"));
    match result {
        Ok(result) => {
            if writeln!(io::stdout().lock(), "{result}").is_ok() {
                ExitCode::SUCCESS
            } else {
                ExitCode::FAILURE
            }
        }
        Err(code) => {
            // Never print SDK/HTTP errors: they may retain private URLs or data.
            let _ = writeln!(io::stderr(), "{}", serde_json::json!({"error": code}));
            ExitCode::FAILURE
        }
    }
}
