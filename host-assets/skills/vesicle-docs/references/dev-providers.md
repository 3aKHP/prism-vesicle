<!-- Generated from docs/dev/PROVIDERS.md — do not edit. -->

# Provider Runtime Contract

This document defines how Vesicle selects providers, translates normalized requests, handles transport behavior, and reports normalized responses. Provider adapters are protocol boundaries, not host workflow owners.

## Adapter Boundary

- Adapters receive a normalized `VesicleRequest` and return a normalized `VesicleResponse`.
- Adapters must not read or write project files, mutate sessions, execute host tools, render TUI state, or know Prism Engine phases.
- Tool definitions and calls remain normalized. The agent loop discovers built-in and MCP tools, exposes ordinary function definitions to adapters, and dispatches returned calls through the owning host registry.
- At the completed normalized-response boundary, every tool-call argument must parse as a JSON object. A malformed call is never dispatched: core replaces its provider-visible arguments with `{}`, preserves only bounded host diagnostics, and emits a paired failed tool result so valid sibling calls and their results remain replayable without repeating side effects. This check is based on argument validity, not the provider finish reason.
- Core materializes durable image references before invoking an adapter. Adapters translate already-materialized data to provider-native image blocks and never read attachment files.
- Core and TUI may select normalized generation controls. Only adapters map those controls to provider wire fields; adapters do not invent host defaults.
- An adapter may implement the optional provider-neutral compact operation. Core supplies normalized messages from one recorded source head; the adapter returns only bounded owner-qualified state and must not mutate the session or reinterpret portable summary text.

## Usage And Metadata

- Responses may report normalized context input, input, output, reasoning, cache, and effective-token counters.
- `contextInputTokens` represents active request occupancy after protocol-specific cache accounting. OpenAI-compatible and Gemini adapters must not count cached tokens twice; Anthropic includes cache creation and read counters where the protocol reports them.
- Provider-specific usage details may be retained under bounded provider metadata, but raw requests, headers, URLs, credentials, and secrets must never enter that metadata.
- Pricing and billing policy live outside adapters.

## Provider-Owned Durable State

- A completed normalized response may carry one owner-qualified `ProviderStateEnvelope`. The envelope binds state to a protocol, provider id, model, and endpoint fingerprint while leaving its `payload` opaque to generic core, session, and TUI code.
- Envelope version 1 accepts JSON-safe data only and is limited to 256 KiB after JSON encoding. Cycles, non-finite numbers, class instances, unknown envelope fields, and unknown required versions fail with an actionable error rather than being stripped or coerced.
- Core may validate, clone, persist, project, rewind, branch, and retain the envelope. Only the matching adapter may interpret its payload or decide whether it is eligible for a later request.
- Provider-owned state must contain only the bounded continuity data required by the adapter. Credentials, authorization or request headers, full request bodies, sockets, callbacks, private identity material, and unbounded diagnostics are forbidden.
- Normalized assistant text, tool calls/results, usage, and display thinking remain their existing authorities. Opaque state must not duplicate them as a competing host truth.
- Provider-native compact state is an optional optimization. Its matching adapter may replay the canonical provider-returned Item window exactly; an owner mismatch or unusable native payload selects the portable checkpoint instead.

## Attempt Commitment

- Each logical provider generation has a host-side commit barrier. Streamed tool-call candidates remain attempt-local and cannot reach Agent Loop dispatch until a structurally valid terminal response commits that attempt.
- A discarded or prematurely ended attempt publishes no tool calls or provider-owned state. Its pending candidates are removed, and a later retry begins a distinct attempt.
- When an adapter reports pending candidates, the terminal response must contain the same ordered calls. A mismatch fails closed. The terminal response remains the sole authority for committed tool calls and durable state.
- Non-streaming responses cross the same commit boundary before Agent Loop observes them. Tool permissions and execution continue only after the committed normalized response returns.

## Transport

- Provider HTTP calls share one retry policy under `providers/shared`.
- Retry only failures that are safe before a response is consumed: connection errors, HTTP 408, HTTP 429, and HTTP 5xx.
- Use bounded exponential backoff with jitter, honor a bounded `Retry-After`, and allow host cancellation to interrupt both fetch and backoff.
- Do not replay a partially consumed stream inside an adapter. Replay after visible deltas or tool calls requires agent-loop and TUI reconciliation.
- Every provider call site forwards retry activity through its host-owned observability surface; call sites must not implement separate retry loops.
- Application-level provider headers are centralized under `providers/shared`. Authentication is applied after the protocol fingerprint, and Bun owns `Host`, `Content-Length`, connection, and compression negotiation.
- Streaming preserves the protocol's expected `Accept` behavior. Gemini selects SSE through `alt=sse`; a shared header layer must not force `text/event-stream` onto every protocol.
- The only registry-configurable application header is provider-level `userAgent`. Arbitrary header overrides are not part of the provider contract.

### Proxy

Provider HTTP(S) and WebSocket traffic share one optional, runtime-only proxy policy owned under `providers/shared`. It is resolved once from configuration and threaded through provider construction; like the API key it is never serialized into `VesicleRequest`, provider state envelopes, session JSONL, quality identity, or the provider registry.

- The canonical setting is one optional `VESICLE_PROVIDER_PROXY` in the user-level `.env` beside `providers.yaml`. A non-empty value must be a complete `http://` or `https://` URL; URL userinfo is the supported Basic-auth mechanism and is carried only on the transport option, never in provider headers. It does not belong in `providers.yaml` or `settings.yaml`, and no project-root `.env` is read.
- Precedence (each blank value is absent and falls through): user-file `VESICLE_PROVIDER_PROXY` → process `VESICLE_PROVIDER_PROXY` → inherited terminal proxy variables → direct. An explicit Vesicle proxy overrides inherited terminal variables and is not bypassed by terminal `NO_PROXY`.
- For an explicit Vesicle proxy, every provider HTTP and WebSocket connection receives Bun's native `proxy` option. URL userinfo is sent as `Proxy-Authorization` automatically; no custom header map, insecure-TLS flag, or custom CA is supported.
- For the inherited path, HTTP defers to Bun's standard-environment behavior, while native WebSocket receives an explicit option resolved to mirror Bun (native WebSocket ignores proxy env vars). Mirroring — not a separate grammar — keeps HTTP and WebSocket on the same route for a given destination.
- Verified against the pinned Bun runtime: for secure (`https:`/`wss:`) targets, `https_proxy`/`HTTPS_PROXY` are honored (lowercase preferred when both are set); `HTTP_PROXY`, `http_proxy`, `ALL_PROXY`, and `all_proxy` are not applied to secure targets. `NO_PROXY` supports `*`, comma-separated entries with surrounding whitespace ignored, exact hostnames (case-insensitive), leading-dot domain suffixes, and IP literals; empty means absent; malformed entries are ignored individually. Port-restricted entries (`host:port`) and `*.` wildcards are not supported because the runtime does not support them — implementing them would make WebSocket diverge from fetch.
- A proxy `407` is terminal for its attempt class and surfaces a stable `proxy_authentication_required` code; known-bad credentials are not retried. A proxy connection failure is a transport attempt and follows the existing retry policy with a sanitized, non-revealing `proxy_connect_failed` code; the proxy URL, host, port, and credentials never enter error messages, causes, diagnostics, or session/quality artifacts.
- `vesicle doctor` reports one bounded line — route state, source class, scheme, and auth yes/no — and never the proxy URL, host, port, credentials, bypass entries, or route fingerprint.

Non-goals: OS proxy discovery, PAC/WPAD, SOCKS, proxy chaining, failover lists, per-provider or per-model proxy selection, NTLM/Negotiate, bearer or custom proxy headers, bundled private CAs, and any `rejectUnauthorized: false` in production. MCP server transports, Tavily web tools, Skill downloads, asset synchronization, git/network shell commands, package-manager traffic, and `shell_exec` child processes do not use the provider transport and do not inherit this policy.

## Protocol Mapping

- OpenAI-compatible adapters preserve normalized reasoning content, assistant tool calls, and tool-result pairing without leaking OpenAI-specific message shapes into core session logic.
- Anthropic Messages adapters emit thinking blocks before text and tool-use blocks, represent tool results as user messages containing `tool_result` (including native `is_error: true` for failed results), and reconstruct streamed blocks by provider content-block index.
- Gemini adapters map the system prompt to `systemInstruction`, conversation to `contents`, and tool results to `functionResponse` parts.
- Anthropic and Gemini history serializers must degrade legacy malformed tool arguments to an empty object rather than throwing before the paired failed result can reach the provider. New records are normalized before persistence; serializer fallback exists for already-written sessions and portable checkpoints.
- Gemini `thought` and `thoughtSignature` metadata remain attached to the original provider-native parts and are replayed as those parts on the next request instead of being reconstructed from assistant prose.
- Provider-native thinking metadata is preserved for protocol continuity and display but must not be merged into ordinary assistant prose.
- The Responses adapter applies request omission, semantic-event admission, and native Item/compact-state ownership by exact `responsesProfile`. Changing profile at the same provider/model/endpoint selects portable history rather than replaying incompatible native state. `openai-public` owns the public OpenAI field/event families. The dated MiMo and DeepSeek subsets omit their unsupported stateful fields, replay full context over HTTP, and explicitly admit only their documented `response.reasoning_text.*` family. Unknown semantic events remain fail-closed.

## Provider Configuration

- Provider profiles live in the user configuration directory, never in project `.vesicle/` state or a project-root `.env`.
- `providers.yaml` contains provider ids, protocols, base URLs, model entries, generation defaults, capability metadata, limits, and `apiKeyEnv` names only. It must not contain secret values.
- The sibling user-level `.env` is the primary secret source. Process environment variables are fallback only and must not let a legacy project-root `.env` override the user-level file.
- A provider may declare `defaultModel` and `userAgent`. A default model must name an entry in the same provider catalog.
- String model entries cover the common case. Object entries may declare `id`, `generation`, `capabilities`, and `limits`.
- `generation.maxTokens` is a request default. `limits.contextWindow` and related limits describe model capacity and context policy; adapters receive the resulting normalized request rather than interpreting host configuration.
- Vision is capability-gated. A non-vision model receives neither image content nor the model-visible image inspection tool.
- Remote provider compaction is capability-gated per model. Capability support does not make it a recovery dependency: portable compaction still runs first and remains authoritative.
- Every `openai-responses` provider declares `responsesProfile`; transport defaults to HTTP and may be set to WebSocket only for a profile that supports it. The dated MiMo subset is HTTP-only, may select Bearer or `x-api-key`, and cannot enable `remoteCompact`. `deepseek-subset-2026-07-31` is Bearer-authenticated, HTTP-only, stateless, and limited to `deepseek-v4-flash` until DeepSeek separately ships and Vesicle accepts v4 Pro support. Other Responses profiles use Bearer authentication; other protocols retain their existing auth rules.

Current protocol availability and known limitations belong in [`STATUS.md`](../../STATUS.md). Example configuration shapes live under [`docs/examples/`](../examples/).

The independent OpenAI Responses adapter is governed by the versioned application-layer evidence, tier boundary, and exclusions in [`OPENAI_RESPONSES_CONFORMANCE.md`](./OPENAI_RESPONSES_CONFORMANCE.md). Supported user configuration is mirrored in the bilingual provider reference; setup and examples must write the same validated schema rather than maintaining an alternate interpretation.
