# MCP Integration

Vesicle's first MCP milestone is a tools-only Streamable HTTP client.

- Config lives at the user-level `mcp.yaml` beside `providers.yaml`; set
  `VESICLE_MCP_FILE` to override it.
- A present `mcp.yaml` defaults to enabled. Use top-level `enabled: false` only
  when you want to keep the file but disable MCP.
- Secrets are expanded from the same sibling `.env` file used by provider and
  Tavily keys.
- `transport: streamable-http` and `transport: http` both select the
  Streamable HTTP client.
- Tools are discovered with `initialize` + paginated `tools/list`, then exposed
  as `mcp_<prefix>_<tool>` aliases.
- `includeTools` and `excludeTools` match either the remote tool name or the
  Vesicle alias.
- `enabledEngines` can scope a server to specific Prism engines.

The client intentionally does not launch local stdio servers yet. That transport
needs a separate process-management pass for Windows PE distribution and local
path/env behavior.
