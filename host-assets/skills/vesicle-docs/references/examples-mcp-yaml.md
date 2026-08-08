<!-- Generated from docs/examples/mcp.yaml — do not edit. -->

# Copy this optional file to the same user-level directory as providers.yaml:
#   ~/.config/prism-vesicle/mcp.yaml
#
# Secrets belong in the sibling .env file, not in this YAML:
#   MCP_CLUSTER_TOKEN=...

# Keep false until the example URL/token are replaced. Real configs may omit
# this field; a present mcp.yaml defaults to enabled.
enabled: false

servers:
  # Absent negotiation normalizes to legacy (no probe, unchanged wire behavior).
  example:
    enabled: true
    # "http" is accepted as a compatibility alias for Streamable HTTP.
    transport: streamable-http
    url: https://mcp.example.com/example/mcp
    timeoutSeconds: 30
    protocolVersion: "2025-03-26"
    toolPrefix: example
    headers:
      Authorization: "Bearer ${MCP_CLUSTER_TOKEN}"
    # Filters match either the remote tool name or Vesicle alias.
    includeTools:
      - search
      - fetch
    excludeTools: []
    # Omit enabledEngines to expose the server to every engine; prefer an
    # explicit list for broad MCP servers.
    enabledEngines:
      - etl
      - evaluate

  # negotiation: auto probes with server/discover first, then falls back to
  # legacy initialize for servers that do not support the modern protocol.
  # Recommended for newly configured remote servers.
  #
  # flexible:
  #   transport: streamable-http
  #   url: https://mcp.example.com/flexible/mcp
  #   negotiation: auto
  #   supportedProtocolVersions: ["2026-07-28"]

  # negotiation: modern connects only through the 2026-07-28 protocol and
  # never falls back to legacy initialize.
  #
  # modern:
  #   transport: streamable-http
  #   url: https://mcp.example.com/modern/mcp
  #   negotiation: modern
  #   supportedProtocolVersions:
  #     - "2026-07-28"
