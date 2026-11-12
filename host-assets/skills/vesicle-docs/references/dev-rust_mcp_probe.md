<!-- Generated from docs/dev/RUST_MCP_PROBE.md — do not edit. -->

# Rust MCP Feasibility Probe

`vesicle-mcp-probe` is a separate, non-published development executable under `rust/mcp-probe`. It uses the official [rmcp SDK](https://docs.rs/crate/rmcp/3.9.0) pinned to 3.9.0, reqwest 0.13.5, Tokio 1.54.1, and Rustls 0.23.46 with the supported ring backend and platform certificate verification. It is not connected to the supported TypeScript product or the Rust session-inspection CLI. SDK types remain inside the probe.

## Deterministic Lane

Run from the repository root with Bun and Node 24 installed:

```sh
bun scripts/smoke/migration/rust-mcp.ts
```

The script builds the probe with the pinned toolchain, then holds independent legacy and modern HTTP connections simultaneously. Separate loopback servers observe discovery/initialization, list/call routing, tool errors versus JSON-RPC errors, cancellation and post-cancellation continuation. Exactly four tool requests per connection prove that failed/cancelled calls are not replayed. The oracle also checks modern per-request version/method/name headers and metadata, absence of a modern session ID, refusal to follow redirects, and redacted error output. Linux and native Windows CI execute this same lane.

The HTTP oracle uses Node 24's native `ServerResponse` close events. Bun still orchestrates the test. The fixture's cancellation barrier refuses a subsequent list response until the cancelled response is closed, so shutting down the whole client cannot masquerade as successful cancellation. The protocol oracle follows the [2026-07-28 discovery schema](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/server/discover.mdx) and [transport-specific cancellation rules](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/basic/patterns/cancellation.mdx): modern discovery includes `resultType: "complete"`; legacy cancellation sends a notification bound to the request ID, whereas modern HTTP cancellation closes its SSE response without a cancellation notification.

## Explicit Live Read-only Lane

When a configured PRTS-compatible service has been authorized for acceptance, use its existing server ID and an ignored evidence directory:

```sh
bun scripts/probe/rust-mcp-live.ts SERVER_ID tmp/mcp-live-evidence
```

This lane requires clean committed source and builds the pinned executable before reading the existing user-level MCP configuration. The launcher executes the exact artifact reported by Cargo, including custom target directories, and records its SHA-256. It does not edit that configuration. Each protocol mode starts a separate authenticated HTTPS connection, lists tools once, and invokes only `list_items` with `limit: 1`. It does not dispatch arbitrary tool names, intentionally cancel remote work, or make provider-generation requests. Authentication is passed only through stdin; it never appears in argv or reports. The Rust client marks headers sensitive and returns fixed error codes instead of SDK error strings. Reports select only the negotiated protocol version, counts, result size/hash, endpoint hash and execution identity; raw responses and configuration are not retained.

Reuse the same evidence directory after a failure. An exclusive lock prevents concurrent budget updates. Each session reserves four RPC slots before launch; at most four sessions and sixteen reservations are allowed across attempts. Reservations replace the ledger atomically after a synced temporary write; empty or malformed existing ledgers fail closed. Reserved failures are not refunded, and there is no automatic budget reset. This covers the explicit startup/list/call flow, not transport-maintenance GET/DELETE requests. A stale lock after interruption requires checking the previous process and evidence before manual recovery. The live lane never runs in CI.

## Bounds And Adoption Limits

The launcher imposes a 45-second hard process deadline, including stdin and cleanup. The binary additionally bounds asynchronous network work to 35 seconds, connection startup to 10 seconds, individual HTTP requests to 8 seconds and service cleanup to 3 seconds. Config input is capped at 16 KiB, SSE events at 512 KiB, and retained live result content at 64 KiB before hashing. Build time is separate from request deadlines. Fixture mode accepts only plain HTTP on `127.0.0.1`; live mode requires HTTPS and a non-empty Authorization header. Environment proxies and redirects are disabled, while normal TLS certificate verification remains enabled.

The probe uses explicit `Initialize` or `Discover` lifecycle modes. It does not use SDK `Auto`, whose timeout-triggered legacy fallback differs from Vesicle's existing error-classification policy. HTTP retries, SSE reconnects and expired-session reinitialization are disabled. Tool calls use the single-round API rather than the automatic multi-round helper.

This proves a finite SDK/protocol path, not complete Rust MCP integration. Product Registry configuration, policy-aware auto negotiation, authentication refresh, permission binding, full media/resource/opaque-result normalization, proxy support, reconnect policy and all production extension capabilities still require their own adapters and acceptance. A successful text-only probe is not evidence for those unimplemented boundaries or for full S1 completion.
