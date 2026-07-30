# OpenAI Responses Conformance Profile

This document owns Vesicle's versioned application-layer comparison target for the independent `openai-responses` adapter. It records evidence and exclusions; it does not claim that the adapter is shipped. Current protocol availability remains in [`STATUS.md`](../../STATUS.md).

## Claim Boundary

The initial target is the public OpenAI `/v1/responses` API using API-key authentication, `store: false`, and a declared model capability profile, compared with OpenAI Codex commit `8f00b9a04cb542ad19a79f9f6c32348421741602`.

Conformance covers application-controlled request fields and omission rules, deterministic JSON key order, public headers other than Vesicle's deliberate User-Agent, ordered input/output Items, typed events, exact `call_id` pairing, retry and terminal behavior, continuation, prewarm, fallback, and provider-native state needed for recovery.

It excludes TLS ClientHello and ALPN, HTTP/2 framing and HPACK, TCP behavior, runtime-owned WebSocket handshake bytes, dynamic server values, and Codex private identity or attestation. Vesicle must not send `x-codex-*` headers, Codex session/thread/turn identities, private `client_metadata`, Responses Lite identity, or attestation merely to resemble Codex. Literal network-stack identity would require a separately approved component that owns and tests those bytes.

## Evidence Fixtures

The sanitized structured fixtures under `tests/fixtures/openai-responses/` are the executable evidence owner:

- `profile-v1.json` pins source revisions, documentation check dates, the claim boundary, and explicit OpenAI/MiMo capability profiles.
- `request-captures-v1.json` classifies every observed field as public required, public optional/profiled, transport-derived, dynamic, or private identity. It also freezes ordered HTTP/SSE, public WebSocket, Codex-beta WebSocket, and prewarm request captures.
- `lifecycle-v1.json` freezes retry count meaning, terminal commit behavior, WebSocket limits, continuation recovery, and side-effect constraints.
- `compatibility-ledger-v1.json` records public-versus-Codex differences and the selected behavior.

The contract suite rejects unclassified captured fields, secret or private identity material, undeclared public/Codex WebSocket differences, and incomplete ledger entries. Later runtime phases use these captures as request, event, lifecycle, and acceptance oracles rather than duplicating prose expectations.

## Frozen Decisions

- HTTP/SSE and WebSocket share one request/event codec. Public WebSocket `response.create` omits `stream` and `background`; the separately selected `codex-beta-2026-02-06` profile sends `stream: true` and its beta header.
- Stateless output Items are retained in API order. As of the 2026-07-30 public documentation check, `encrypted_content` is returned by default for stateless reasoning; the legacy `reasoning.encrypted_content` include remains accepted. The initial Codex-conformance profile sends the include for application parity, while subset profiles send it only when explicitly supported.
- A complete function-call Item remains pending until a structurally valid `response.completed`. A failed attempt cannot commit assistant/native state or start a host side effect.
- Five retries follow the triggering WebSocket attempt before a permanent active-session HTTPS downgrade. Each retry starts with a fresh attempt accumulator, and cancellation never retries.
- Public WebSocket mode permits one in-flight response, no multiplexing, and a 60-minute connection. Vesicle's selected owner is one eligible socket per active session and exact provider owner; it must close on owner or lifecycle changes.
- MiMo is a capability-declared Responses-compatible subset, not an OpenAI/Codex conformance profile. Its frozen 2026-07-29 profile omits unsupported continuation/compaction fields and explicitly owns `response.reasoning_text.*` events.

## Updating The Profile

Profile updates are reviewed fixture changes:

1. Pin the new Codex commit and record exact source paths and line ranges.
2. Re-check every listed public document and third-party subset document; update the dates.
3. Capture sanitized structured requests and lifecycle evidence. Never capture credentials, auth values, private URLs, user prompts, installation IDs, attestation, or private metadata.
4. Classify every new field before accepting it. Unknown fields block the oracle; they are never copied or omitted silently.
5. Add a compatibility-ledger entry for every public/Codex divergence and choose behavior per explicit transport/capability profile.
6. Run `bun test tests/contract/providers/openai-responses-conformance.test.ts`, then the normal repository gates.

Changing this profile does not silently migrate persisted sessions or enable a runtime feature. Runtime delivery and user-facing exposure remain separately reviewed phases.
