<!-- Generated from docs/user/en/advanced/mcp.md — do not edit. -->

# MCP tools

🟢 MCP tools · 🟡 Output persistence experimental

English | [简体中文](../../zh-CN/advanced/mcp.md)

MCP (Model Context Protocol) lets you connect Vesicle to **external tools**. Once configured, the model can call these external capabilities from within the conversation—query a database, search your knowledge base, hit your own API—just like a built-in tool, without leaving the terminal.

Each configured MCP server gives the model a set of tools, named like `mcp_<prefix>_<tool>`. These external tools are managed the same way as Vesicle's built-in ones: you'll be asked to confirm when appropriate, and returned content is checked—being external doesn't mean less scrutiny.

> For the full list of config fields, see the `mcp.yaml` section of [Configuration](../reference/configuration.md). This page is about usage.

## Configure an MCP server

Start from [`docs/examples/mcp.yaml`](../../../examples/mcp.yaml): copy it to the same directory as `providers.yaml` (default `~/.config/prism-vesicle/mcp.yaml`). A minimal working config:

```yaml
enabled: true

servers:
  mykb:
    transport: streamable-http
    url: https://mcp.example.com/mcp
    toolPrefix: mykb
    headers:
      Authorization: "Bearer ${MCP_TOKEN}"
    enabledEngines:
      - etl
      - evaluate
```

- `enabled: true` turns MCP on. A present file defaults to enabled; set `false` to temporarily disable all servers.
- Auth tokens go in a sibling `.env` file (`MCP_TOKEN=...`) and are referenced as `${MCP_TOKEN}` in `headers`; **never** put secrets directly in the YAML.
- `enabledEngines` restricts which engines can use the server; omit to allow all. For broad servers, prefer an explicit list.
- `includeTools` / `excludeTools` keep or remove specific tools.
- See [Configuration](../reference/configuration.md) for full field descriptions.

## Connection: legacy / auto / modern

MCP servers may speak one of two protocol versions, old or new. Vesicle supports both, and a single process can mix them. Each server can choose which to use:

| `negotiation` | Behavior | When to use |
|---|---|---|
| `legacy` (default) | Connects the traditional way only, no attempt at the new protocol | Server known to support only the old protocol, or keep an existing config unchanged |
| `auto` | Tries the new protocol first, uses it on success, falls back to the old way otherwise | **Recommended for newly configured servers** |
| `modern` | Uses the new protocol only, no fallback | Server confirmed to support the new protocol, and no old-protocol traffic is desired |

`protocolVersion` pins the old-protocol revision (default `2025-03-26`); `supportedProtocolVersions` is an optional list for the new protocol. Neither decides which protocol is used—that's what `negotiation` does.

Check whether things connect with `vesicle doctor`, which lists each server's connection mode, protocol version, tool count, and any error:

```text
MCP server mykb (auto): connected [modern] 2026-07-28, 4 tools
MCP server legacy-srv (legacy): connected [legacy] 2025-03-26, 2 tools
MCP server down-srv (auto): error (timeout)
```

The sidebar MCP section shows a short protocol marker.

## Tool visibility and permissions

- Once configured, a server's tools show up in the model's tool list, named like `mcp_<toolPrefix>_<tool>` (`toolPrefix` derives from the server name when not set).
- Vesicle treats every MCP tool as one that **may have external effects**—it doesn't take the server's own description at face value. What this means for you under each permission mode:
  - **MANUAL / INERTIA**: every call asks you first.
  - **MOMENTUM / YOLO**: calls go through without asking.
- For choosing a permission mode, see [Permissions and security model](../reference/permissions-and-security.md).

## What comes back: what the model sees

- **Text**: kept in the order the server returns it.
- **Images**: only when the active model supports vision (`capabilities.vision: true`) are PNG/JPEG/GIF/WebP images checked and sent to the model. If the model can't handle images, they're skipped—text still comes through, and you're told how many images were omitted. MCP error results never carry images either. Single-image limit is currently 20 MiB.
- **Not-yet-supported kinds** (resource, audio, URL/link, etc.): only a brief "not supported" notice is given. Vesicle **never** downloads, reads, transcribes, or plays such content on its own.

## Saving tool output (experimental)

By default, an MCP tool's result lives only in the current conversation—once it scrolls past, it's gone: to see it again the model must re-invoke, and that call may cost money, have side effects, or be impossible to repeat. Turn on output persistence and every MCP call's text and images are also saved to disk, so the model can go back and read the saved copy with `read_file`, `grep_files`, and `view_image` instead of repeating the call.

Enable it in `.vesicle/preferences.yaml` at the project root:

```yaml
version: 1
mcpOutputPersistence: true            # master toggle, off by default
mcpOutputAutoTruncate: true           # optional, requires the master toggle
```

| Master | Truncate | Effect |
|---|---|---|
| on | off | Full result is **sent to the model as usual, and saved too**—no context savings, effectively a backup |
| on | on | Results over 32 KiB send only a 4 KiB preview to the model, plus a note saying where the full copy is; smaller ones go through in full |

- Text is saved under `tmp/mcp-output/<session-id>/`, images under `.../blob/` (saved as native `.png`/`.jpg`, not encoded text). Filenames are built from the tool name and its arguments, so they're easy to find.
- No manual action needed once it's on: Vesicle tells the model where results are saved, and the model decides for itself when to go read them. `/resume` reuses the same session id, so the files stay at their original paths.
- Saving is best-effort and never affects the result itself: even if the save fails, the model still receives what it should.
- This feature is still experimental and off by default; the model is told about it only when the current engine actually has MCP tools.

> These saved files live in `tmp/`: `/rewind` doesn't touch them, and Vesicle never cleans them up automatically. Delete them yourself with the file tools when you're done. See [Permissions and security model](../reference/permissions-and-security.md) for the full `tmp/` behavior.

## Limitations

- Only the Streamable HTTP connection type is supported; local processes (stdio), OAuth login, and MCP resources/prompts aren't available yet.
- Only text and images are handled; resource, audio, URL/link, and similar kinds get a "not supported" notice and are never auto-fetched.
- The full capability boundary and known limits are in [`STATUS.md`](../../../../STATUS.md).

## Troubleshooting

- **Tools missing / won't connect**: run `vesicle doctor` first and check each server's connection mode, protocol, and error. Confirm `mcp.yaml` is in the right place (beside `providers.yaml`), `enabled: true`, and the token is set in `.env`.
- **Timeout / connection refused**: raise `timeoutSeconds`; confirm the server address is reachable.
- See [Troubleshooting](../reference/troubleshooting.md) for more.
