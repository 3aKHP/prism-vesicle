# MCP Integration

Vesicle is a tools-only MCP Client that supports both legacy (`initialize`) and modern (`server/discover`) protocol eras over Streamable HTTP. One Vesicle process can connect to multiple MCP Servers concurrently, each using a different era.

## Protocol eras

- **Legacy era** (`2024-10-07` through `2025-11-25`): connects with `initialize`, saves `Mcp-Session-Id`, paginates `tools/list`, and calls `tools/call`. This is the default for existing configurations.
- **Modern era** (`2026-07-28`): connects through `server/discover`, sends per-request `_meta` envelope and modern routing headers (`MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`), and cancels by closing the SSE response stream. No `initialize`, no session.

The SDK (`@modelcontextprotocol/client@2`) owns wire negotiation, typed errors, and incremental Streamable HTTP behavior. Vesicle wraps it in a thin adapter that converts at the `src/mcp` boundary — SDK types never enter `core/`, providers, Engine profiles, permission runtime, or TUI rendering.

## Configuration

Config lives at the user-level `mcp.yaml` beside `providers.yaml`; set `VESICLE_MCP_FILE` to override it.

- A present `mcp.yaml` defaults to enabled. Use top-level `enabled: false` only when you want to keep the file but disable MCP.
- Secrets are expanded from the same sibling `.env` file used by provider and Tavily keys.
- `transport: streamable-http` and `transport: http` both select the Streamable HTTP client.
- `negotiation` accepts `legacy`, `modern`, or `auto`. Absent normalizes to `legacy` (no probe, unchanged wire behavior).
- `protocolVersion` is the legacy revision pin (default `2025-03-26`). It does not select the era.
- `supportedProtocolVersions` is an optional modern offer list (default `["2026-07-28"]`). It must contain at least one Vesicle-supported modern revision.
- `includeTools` and `excludeTools` match either the remote tool name or the Vesicle alias.
- `enabledEngines` can scope a server to specific Prism engines.

```yaml
servers:
  old_server:
    transport: streamable-http
    url: https://legacy.example.test/mcp
    negotiation: legacy
    protocolVersion: "2025-03-26"

  flexible_server:
    transport: streamable-http
    url: https://dual.example.test/mcp
    negotiation: auto
    supportedProtocolVersions: ["2026-07-28"]

  modern_server:
    transport: streamable-http
    url: https://modern.example.test/mcp
    negotiation: modern
    supportedProtocolVersions:
      - "2026-07-28"
```

## Auto negotiation

`negotiation: auto` probes with `server/discover` and selects the era independently per Server:

- Valid discover result with common version → modern connected.
- Authoritative legacy-only signal → fresh legacy `initialize`.
- Auth failure (401/403), server failure (5xx), timeout, network error, or ambiguous response → fail, no fallback.
- Probe verdicts are not persisted across process restarts.

## Tools-only surface

The first delivery is tools-only:

- `tools/list` (paginated) and `tools/call` are supported in both eras.
- Both eras normalize into the same `ToolDefinition`, `ToolCall`, `ToolResult`, permission, Engine-scope, alias, result-delivery, and session-event boundaries.
- Supported inline PNG/JPEG/GIF/WebP images are strictly validated and enter the attachment path only for vision-capable models.
- Resource, audio, URL/link, and unknown result items are omitted with bounded diagnostics. They are not fetched, injected, or promoted into a wider scope (see #177).
- `input_required` (modern MRTR) is rejected with a stable unsupported-capability error — no retry or side effect.
- Automatic `subscriptions/listen` is not enabled.

## Error classification

Vesicle classifies connection and protocol failures into stable host-only kinds: `config`, `probe`, `auth`, `timeout`, `transport`, `legacy-handshake`, `stale-session`, `modern-negotiation`, `routing`, `unsupported-capability`, and `protocol`. These appear in Doctor and sidebar status without exposing secrets, private URLs, or raw payloads.

## Migration policy

- Absent `negotiation` means `legacy`, not `auto`. Existing configurations produce the same legacy wire sequence after upgrade.
- Existing YAML is never rewritten eagerly.
- Setup-generated entries use `negotiation: auto` (probes first, falls back to legacy).

## Deferred capabilities

Local stdio transport, classic HTTP+SSE, MCP prompts/resources APIs, roots, sampling, elicitation, logging control, change subscriptions, tasks, OAuth, resource/audio/URL result delivery (#177), and generic long-result spill (#137B) are not part of this delivery.
