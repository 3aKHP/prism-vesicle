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

## Protocol Mapping

- OpenAI-compatible adapters preserve normalized reasoning content, assistant tool calls, and tool-result pairing without leaking OpenAI-specific message shapes into core session logic.
- Anthropic Messages adapters emit thinking blocks before text and tool-use blocks, represent tool results as user messages containing `tool_result` (including native `is_error: true` for failed results), and reconstruct streamed blocks by provider content-block index.
- Gemini adapters map the system prompt to `systemInstruction`, conversation to `contents`, and tool results to `functionResponse` parts.
- Anthropic and Gemini history serializers must degrade legacy malformed tool arguments to an empty object rather than throwing before the paired failed result can reach the provider. New records are normalized before persistence; serializer fallback exists for already-written sessions and portable checkpoints.
- Gemini `thought` and `thoughtSignature` metadata remain attached to the original provider-native parts and are replayed as those parts on the next request instead of being reconstructed from assistant prose.
- Provider-native thinking metadata is preserved for protocol continuity and display but must not be merged into ordinary assistant prose.

## Provider Configuration

- Provider profiles live in the user configuration directory, never in project `.vesicle/` state or a project-root `.env`.
- `providers.yaml` contains provider ids, protocols, base URLs, model entries, generation defaults, capability metadata, limits, and `apiKeyEnv` names only. It must not contain secret values.
- The sibling user-level `.env` is the primary secret source. Process environment variables are fallback only and must not let a legacy project-root `.env` override the user-level file.
- A provider may declare `defaultModel` and `userAgent`. A default model must name an entry in the same provider catalog.
- String model entries cover the common case. Object entries may declare `id`, `generation`, `capabilities`, and `limits`.
- `generation.maxTokens` is a request default. `limits.contextWindow` and related limits describe model capacity and context policy; adapters receive the resulting normalized request rather than interpreting host configuration.
- Vision is capability-gated. A non-vision model receives neither image content nor the model-visible image inspection tool.

Current protocol availability and known limitations belong in [`STATUS.md`](../../STATUS.md). Example configuration shapes live under [`docs/examples/`](../examples/).

The independent OpenAI Responses adapter is governed by the versioned application-layer evidence and exclusions in [`OPENAI_RESPONSES_CONFORMANCE.md`](./OPENAI_RESPONSES_CONFORMANCE.md). That profile does not make Responses available before the runtime adapter ships.
