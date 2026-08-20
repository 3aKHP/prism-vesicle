<!-- Generated from docs/user/en/reference/configuration.md — do not edit. -->

# Configuration files

English | [简体中文](../../zh-CN/reference/configuration.md)

Vesicle's configuration is **user-level** and separate from your project directories. One configuration serves all your projects.

## Config directory

All configuration files live in one user directory:

| Platform | Default directory |
|---|---|
| Windows | `%APPDATA%\prism-vesicle\` |
| Linux / macOS | `$XDG_CONFIG_HOME/prism-vesicle/`, or `~/.config/prism-vesicle/` |

Override with environment variables: `VESICLE_CONFIG_DIR` (the whole directory) or `VESICLE_PROVIDERS_FILE` (just the providers file; its directory is used).

Display variables unrelated to the config directory: `VESICLE_REDUCED_MOTION=1` freezes the startup splash as a still frame, for motion-sensitive users or low-power terminals. `VESICLE_THEME=dark|light|default|auto` selects the interface theme, with four value semantics: `dark`/`light` force a theme; `default` follows the terminal's own light/dark mode (falling back to dark until one reports); `auto` follows the clock (light 07:00–19:00 local, dark otherwise). An invalid value surfaces a diagnostic and falls back to `default` rather than being silently treated as `auto`. Inside a session `/theme` switches temporarily (higher priority), and at launch the `--dark`/`--light` process flags select the initial preference; per-project persistence is covered [below](#project-theme-preference-optional).

Files in that directory:

| File | Required | Contents |
|---|---|---|
| `providers.yaml` | Yes | Providers, models, protocols, endpoints, `apiKeyEnv` names |
| `.env` | Yes | The corresponding secret values |
| `mcp.yaml` | No | Optional MCP tool servers |
| `permissions.yaml` | No | Tool-approval default and the `shell_exec` switch (see [permissions](./permissions-and-security.md)) |
| `quality.yaml` | No | Experimental Semantic Judge (`version: 2`; `mode: off` may retain a dormant provider/model/timeout tuple). See [quality guard](../advanced/quality-guard.md); `/quality` is the normal path |
| `settings.yaml` | No | User-level host settings (`editor:` for the Workspace `Ctrl+X` external editor; reserved for future settings) |
| `assets/` | No | User-level asset overrides |
| `VESICLE.md` / `VESICLE.<engine>.md` | No | Persistent Instructions (user-level, applies across all projects; see below) |

> Do not rely on a project-root `.env`. If an old one remains, move its values into the user directory above and remove it.

## providers.yaml

For the full canonical shape, see [`docs/examples/providers.yaml`](../../../examples/providers.yaml). Structure highlights:

```yaml
default:               # provider and model selected at startup
  provider: deepseek
  model: deepseek-v4-flash

providers:
  deepseek:
    protocol: openai-chat-compatible   # or openai-responses / Anthropic / Gemini
    baseUrl: https://api.deepseek.com/v1
    apiKeyEnv: DEEPSEEK_API_KEY        # the variable name only; the secret itself goes in .env
    defaultModel: deepseek-v4-flash    # optional: what /model deepseek switches to
    models:
      - id: deepseek-v4-flash
        capabilities: { streaming: true, tools: true }
        limits: { contextWindow: 1000000, maxOutputTokens: 65536 }
      - id: deepseek-reasoner
        generation: { temperature: 0.4, maxTokens: 8192 }
        capabilities: { streaming: true, tools: true, reasoningTier: true }
        limits:
          contextWindow: 1000000
          maxOutputTokens: 65536
          autoCompact: { enabled: true, threshold: 0.85, reserveOutputTokens: 20000 }
  local:
    protocol: openai-chat-compatible
    baseUrl: http://127.0.0.1:11434/v1
    apiKeyEnv: LOCAL_OPENAI_COMPAT_API_KEY
    models:
      - qwen3            # a string shorthand is also fine, with no extra config
```

Field notes:

- `protocol`: one of `openai-chat-compatible`, `openai-responses`, `anthropic-messages`, `gemini-generate-content`.
- `apiKeyEnv`: **the environment-variable name only**; the real secret goes in `.env`. `providers.yaml` itself never holds secrets.
- `authMethod`: Anthropic or MiMo Responses may use `x-api-key`; Gemini uses `x-goog-api-key`. OpenAI-family protocols default to Bearer authentication when this field is omitted.
- `userAgent` (optional): replaces the User-Agent for this provider only; other fingerprint and auth headers stay fixed.
- A model entry can be a string shorthand or an object with `generation` (`temperature`/`maxTokens`), `capabilities` (`streaming`/`tools`/`vision`/`reasoningTier`/`reasoningContent`/`builtinWebSearch`), `limits` (`contextWindow`/`maxOutputTokens`/`autoCompact`), and an optional top-level `webSearchDefault`.
- `capabilities.builtinWebSearch: true` declares that the model supports the provider-native built-in web search; `webSearchDefault: true` starts new sessions with it on (off when omitted). The two are independent: the preference alone never enables a model that does not declare the capability. Use `/websearch on|off` to override per session; `/new` or resuming a session reverts to the default. While enabled, searches run on the provider side, queries leave with the request, and no per-call approval applies — see the privacy policy; the host `web_search` (Tavily) tool is removed from the tool surface to avoid two competing search paths.
- `limits.contextWindow` enables the context percentage in the status bar. `autoCompact` opts into automatic context compaction: it activates only when `enabled` is not `false`, `threshold` is strictly between 0 and 1, and `contextWindow` is a positive integer; once active, Vesicle compacts (via the portable `/compact` checkpoint) before a new top-level prompt and at safe mid-turn boundaries when the projected next request crosses the soft trigger. Every provider send is checked after queued input and completed background-process notifications are included. `reserveOutputTokens` reserves space for the next output (precedence: `reserveOutputTokens` → generation `maxTokens` → `limits.maxOutputTokens` → 0); provider loading rejects a statically known reserve that leaves no positive input budget. There is no hidden default threshold. Run `/context` to inspect the effective soft trigger, hard input ceiling, reserve source (including the active model's generation defaults), and activation state.

### OpenAI Responses profiles

`openai-responses` also requires an explicit `responsesProfile`; Vesicle never guesses capabilities from a URL, provider id, or model name. Guided Setup can select OpenAI Responses, the MiMo Responses subset, or the DeepSeek Responses subset and writes a conservative HTTP configuration. Complete copyable examples live in [`docs/examples/providers.yaml`](../../../examples/providers.yaml).

The independent Responses protocol graduated from opt-in experimental to released with 1.0.0-alpha.10; the full `openai-public` real-provider gate passed on 2026-08-11 across HTTP/typed SSE, non-stream JSON, standalone compact, and public WebSocket (`3` pass, `0` fail). On 2026-07-31, the MiMo endpoint and DeepSeek v4 Flash each passed their reasoning and function-loop cases (`2` pass, `0` fail per subset). On 2026-08-13, after DeepSeek enabled official v4 Pro Responses support, `deepseek-v4-pro` passed the same reasoning and function-loop cases (`2` pass, `0` fail) and `deepseek-v4-flash` retained its regression pass.

- `openai-public` is the public protocol profile for the official `api.openai.com` endpoint. It supports HTTP/typed SSE and an explicit `responsesTransport: websocket` selection. It preserves ordered Items, exact `call_id` values, stateless encrypted reasoning, session-scoped WebSocket continuation, and `/responses/compact` when the model entry declares `capabilities.remoteCompact: true`. It also admits the provider-side built-in web search declaration and its `web_search_call` Items/events (paired with the model entry's `builtinWebSearch` capability and the `/websearch` toggle). This is an application-layer protocol claim, not a claim of Codex-identical TLS or HTTP/2 fingerprints.
- `mimo-subset-2026-07-30` is a dated third-party compatibility subset and is HTTP-only. It omits MiMo-undeclared or explicitly unsupported `background`, `context_management`, `previous_response_id`, `parallel_tool_calls`, `store`, remote-compaction, and WebSocket fields, fully replays context on every round, and explicitly maps `response.reasoning_text.*` into Vesicle reasoning. It is not OpenAI or Codex conformance.
- `deepseek-subset-2026-07-31` is the dated HTTP subset DeepSeek documents for `deepseek-v4-flash` and `deepseek-v4-pro`. It uses Bearer authentication, omits unsupported continuation, Conversations, storage, background, WebSocket, and remote-compaction fields, fully replays context including plaintext reasoning Items, and maps DeepSeek's documented `none`/`low`/`high`/`max` efforts. Both models were independently accepted against the official endpoint on 2026-08-13; other models remain excluded.
- `deepseek-subset-2026-08-19` copies every constraint of `2026-07-31` and additionally admits the provider-side built-in web search: it declares the bare `web_search` tool, admits `web_search_call` Items and events, and normalizes the executed queries and call records into the session. The guided Setup DeepSeek Responses preset now writes this newer profile; existing configurations keep their declared profile and should switch to this one — plus a model-entry `builtinWebSearch` declaration — to use built-in search. Its search and replay acceptance ran against the official endpoint on 2026-08-20.
- `codex-http-relay` is the HTTP-only maximum-compatibility profile for gateways that serve Codex: it accepts public-style terminal ordered output and the Codex event-terminal split where contiguous completed Items carry the payload and a later valid `response.completed` leaves `output` empty or omitted. Vesicle still waits for the successful terminal before committing tools, requires any non-empty dual representation to match, and rejects failed/incomplete/EOF attempts.
- `codex-beta-2026-02-06` is a fingerprint-level Codex simulation profile: with WebSocket transport it sends the Codex V2 beta wire shape (the `openai-beta: responses_websockets=2026-02-06` header plus `stream: true`) and falls back to HTTPS/SSE on WebSocket exhaustion, exactly as Codex does; over HTTPS/SSE it is indistinguishable from `openai-public`. Use it when WebSocket traffic should match the Codex V2 beta shape. None of the Codex-shaped profiles copies private identity, attestation, or `x-codex-*` headers.

`responsesTransport` is `http` or `websocket`; when omitted, runtime behavior is HTTP. Only `openai-public` and `codex-beta-2026-02-06` permit WebSocket; the MiMo and DeepSeek subsets are HTTP-only. Native Items and compact state are owned by the exact profile; changing profiles at one endpoint falls back to portable history. Portable `/compact` checkpoints remain the recovery authority whether or not remote compaction is enabled; an unavailable remote endpoint never makes an existing session unreadable. Run `vesicle doctor` to inspect the selected Responses profile, tier, transport, and remote-compaction declaration.

## .env

Put values here for every `apiKeyEnv` named in `providers.yaml`. Start from [`docs/examples/provider.env.example`](../../../examples/provider.env.example):

```text
DEEPSEEK_API_KEY=
OPENAI_API_KEY=
MIMO_API_KEY=
ANTHROPIC_API_KEY=
GEMINI_API_KEY=
LOCAL_OPENAI_COMPAT_API_KEY=
TAVILY_API_KEY=
MCP_CLUSTER_TOKEN=
```

`TAVILY_API_KEY` enables the web research tools for the ETL/Evaluate engines; MCP auth tokens also go here. Process environment variables are a fallback only.

## `vesicle config` command reference

In addition to hand-editing YAML, Vesicle ships a validated, atomic configuration command surface since 1.0.0-alpha.10 (the bundled `update-config` Skill guides changes through the same commands). Every registry write is re-parsed after serialization and applied by an atomic rename, so a failed cross-field constraint never leaves a corrupted file. Secret values are structurally excluded: no command accepts a secret as an argument.

```text
vesicle config path
vesicle config show <providers|env|permissions|mcp|quality|settings|preferences>
vesicle config set <file> <key> <value>
vesicle config add-provider --json '<entry>'
vesicle config add-model <provider-id> --json '<entry>'
vesicle config remove-model <provider-id> <model-id>
vesicle config remove-provider <provider-id>
vesicle config unset <file> <key>
vesicle config env-set-empty <KEY>
vesicle config env-set-proxy <URL>
vesicle config env-remove <KEY>
vesicle config validate
```

- `path` prints the user-level config directory; `show` prints **sanitized** state: `.env` entries always render as `<set>`/`<empty>` markers and proxy credentials are masked.
- `set` modifies keys in providers/permissions/preferences/quality/settings; provider entries support per-field edits (`protocol`, `baseUrl`, `apiKeyEnv`, `authMethod`, `responsesProfile`, `responsesTransport`, `userAgent`, `defaultModel`); structural fields (`id`, `models`, `apiKey`) are rejected.
- `add-provider`/`add-model` append entries, `remove-model`/`remove-provider` delete them; `unset` removes a key from preferences/settings.
- `env-*` manages only the non-secret `.env` structure: empty placeholders, the proxy URL, and key removal (removing a missing key warns); API keys are still edited manually in `.env` as above.
- `validate` validates all configuration files.

If you paste a credential into the conversation, Vesicle only warns — it never echoes, stores, or uses it.

## Provider proxy (optional)

A single optional key `VESICLE_PROVIDER_PROXY` lives in the `.env` above (beside `providers.yaml`). If your network requires a proxy to reach model providers, set it before running `vesicle setup`; Setup model discovery and later provider requests use the same setting. A non-empty value must be a complete `http://` or `https://` proxy URL:

```text
VESICLE_PROVIDER_PROXY=http://127.0.0.1:7890
```

For Basic auth, put the username and password in the URL; percent-encode reserved characters such as `@`, `:`, and `/` inside either value:

```text
VESICLE_PROVIDER_PROXY=http://username:password@proxy.example.com:8080
```

URL credentials are carried only on the transport and are never written to `providers.yaml`, sessions, or logs. Exit and restart Vesicle after changing `.env`.

It applies to **all model-provider HTTP(S) and WebSocket** traffic, including model requests from the main workflow, SubAgents, Quality Judge, and compaction. It is not a global Vesicle network proxy. MCP, Tavily/Web tools, Skill downloads, asset synchronization, Git/package managers, `shell_exec`, and its child processes do not use this setting.

Precedence: user-file `VESICLE_PROVIDER_PROXY` → process `VESICLE_PROVIDER_PROXY` → inherited terminal proxy variables (`https_proxy`/`HTTPS_PROXY`, etc.) → direct; a blank value means "unset" (it falls through) rather than "force direct". Therefore, a non-empty user-file value cannot be overridden by a temporary process variable. An explicit setting overrides inherited terminal proxies and is not bypassed by terminal `NO_PROXY`.

For one launch without editing the file:

```bash
# Linux / macOS / WSL
VESICLE_PROVIDER_PROXY=http://127.0.0.1:7890 vesicle .
```

```powershell
# PowerShell 7
$env:VESICLE_PROVIDER_PROXY = "http://127.0.0.1:7890"
vesicle .
```

Inherited behavior matches the pinned Bun runtime: for `https://`/`wss://` targets only `https_proxy`/`HTTPS_PROXY` are honored (lowercase preferred when both are set); `HTTP_PROXY`/`ALL_PROXY` do not apply to secure targets; `NO_PROXY` supports `*`, exact hostnames (case-insensitive), and leading-dot suffixes (e.g. `.test`), but not `:port` or `*.`. OS proxy discovery, PAC/WPAD, SOCKS, proxy chaining, per-provider selection, NTLM, custom proxy headers, and production TLS bypass are not supported. `vesicle doctor` shows only route state, source, scheme, and whether auth is configured — never the proxy address or credentials.

After restarting, run `vesicle doctor` and inspect the `Provider proxy:` line. `configured` means a proxy route is selected, `inherited` means it came from the terminal environment, `bypassed` means `NO_PROXY` bypasses it for the selected provider endpoint, `direct` means no proxy route, and `invalid` means the explicit URL is invalid. For example:

```text
Provider proxy: configured (user file; http; no authentication)
```

Doctor checks route selection only; it does not prove that the proxy or provider is reachable. Send one real model request to complete the connectivity check. See [Troubleshooting](./troubleshooting.md) for errors.

## Providers and cost (for beginners)

- An **API key** is a string you get from a model provider (DeepSeek, Anthropic, Google, or a local compatible service) that identifies your account.
- The **Base URL** is that provider's endpoint address; Vesicle sends requests to it.
- **Cost** is billed by the provider by usage (tokens); Vesicle itself charges nothing. Model prices vary widely — when unsure, try a cheaper model first.
- Local models (such as Ollama) connect through an OpenAI-compatible endpoint; point the Base URL at `http://127.0.0.1:<port>/v1`.

## mcp.yaml (optional)

Start from [`docs/examples/mcp.yaml`](../../../examples/mcp.yaml). Each server can set `transport` (streamable-http), `url`, `timeoutSeconds`, `toolPrefix`, `headers` (supports `${ENV_VAR}` expansion from `.env`), `includeTools`/`excludeTools` filters, and `enabledEngines` (which engines can use it). A present `mcp.yaml` defaults to enabled; secrets go in `.env`.

You can also add servers with `vesicle config add-mcp --json '<entry>'` and remove them with `vesicle config remove-mcp <server-id>`; removing the last server deletes the whole `mcp.yaml`. Neither command accepts secrets—they create or preserve `.env` slots for you to fill in manually. See [MCP tools](../advanced/mcp.md).


Vesicle supports dual-era Streamable HTTP MCP tools: one Vesicle process can connect to both legacy (`initialize` handshake) and modern (`server/discover`) MCP servers concurrently. Each server can set `negotiation`:

- `legacy` (default when absent): uses the `initialize` path only, no modern probe.
- `auto`: probes with `server/discover` first, then falls back to legacy for servers that do not support the modern protocol. Recommended for newly configured remote servers.
- `modern`: connects only through the `2026-07-28` protocol, never falls back to legacy.

`protocolVersion` is the legacy revision pin (default `2025-03-26`); it does not select the era. `supportedProtocolVersions` is an optional modern offer list (default `["2026-07-28"]`).

MCP tool results first cross the host's untrusted-content boundary. Ordinary text keeps its original order. When the selected model declares `capabilities.vision: true`, strictly validated inline PNG, JPEG, GIF, and WebP images are delivered as image attachments. Sessions retain only content-addressed references, never base64. The current 20 MiB decoded-image ceiling is a provisional safety boundary, not a configurable long-term product commitment.

For a non-vision model, images are neither decoded nor persisted; safe text continues with an omission notice. MCP error results also do not import images. Resource, audio, URL/link, and unknown results currently produce only bounded unsupported-item notices; Vesicle does not automatically download, read, transcribe, play, or inject them.

## Persistent Instructions (optional)

If you keep re-stating the same sub-workflow or specification under an engine, write it into a Persistent Instructions file — the host loads it into the system prompt automatically at the start of every session, so you no longer have to ask the model to write a spec to a file and remind it to read it next session.

Two scopes, same file names: `VESICLE.md` (general, every engine) and `VESICLE.<engine>.md` (engine-specific override, where `<engine>` is `etl`, `runtime`, `stage`, etc.).

- **Project scope**: at the project root (for example `VESICLE.md`, `VESICLE.runtime.md`); travels with the project and may be committed.
- **User scope**: in the config directory above (beside `providers.yaml`); **applies across every project root**, so you do not have to copy files between working folders.

Resolution: **within one scope an engine-specific file replaces the general file; across scopes the user file is followed by the project file, and the project file wins on a direct conflict.** A present engine-specific file always replaces the general one (an empty file is an explicit empty override that suppresses fallback to the general file). Instructions may only customize behavior within the active engine's workflow — they **cannot** add tools, permissions, gates, validators, or filesystem authority; capability boundaries stay host-enforced.

Instructions are appended after the engine prompt as host context (the engine contract remains the single system authority) and are read from current disk when a top-level turn begins; within one turn the selection is frozen, so an edit you make while a turn is paused (for example during a tool approval) takes effect on the next turn rather than mid-turn. An invalid, linked, or oversized instruction file is skipped with a warning rather than blocking the turn; the combined user + project content is capped at 32 KiB. Inspect the active selection with `/instructions`, or run `vesicle prompt shape --engine <id>` from the command line. Run `/init` to draft a `VESICLE.md` from a project scan, then edit it by hand. If the project root already contains `VESICLE.md`, ordinary `/init` refuses before calling the provider; only `/init --force [notes]` backs the old file up to `.vesicle/init-backups/VESICLE.md.previous` and replaces it. The model can also read or update these instructions with the `read_instructions` / `update_instructions` tools (non-Stage engines; `update_instructions` goes through the active permission mode with atomic write and an automatic backup, and takes effect on the next provider round of the same turn).

Persistent Instructions are host configuration, not guarded artifacts. `/rewind` and double-Esc do **not** restore an on-disk `VESICLE.md` / `VESICLE.<engine>.md` changed by `update_instructions`, even if the rewind removes that tool call from the conversation; the changed instruction remains active. After each successful mutation the tool result reports the single previous-state backup: project scope uses `.vesicle/instruction-backups/<scope>-<filename>.previous`, while user scope uses `instruction-backups/` in the config directory; a first creation has only the matching `.previous.json` recording that the target was absent. Recovery is currently manual: copy `.previous` back over the target, or delete a first-created target. A later mutation replaces this one backup.


## Project theme preference (optional)

If you want a particular working directory to default to a specific theme, place a `.vesicle/preferences.yaml` at the project root (local ignored state — **not** tracked in version control):

```yaml
version: 1
theme: auto   # dark | light | default | auto
# mcpOutputPersistence: true   # opt in: persist MCP tool outputs under tmp/mcp-output/
# mcpOutputAutoTruncate: true  # requires mcpOutputPersistence: inline-preview oversized results
```

- `version: 1` is required; `theme` is optional and accepts `dark`/`light`/`default`/`auto`; omitting `theme` means no project override. `mcpOutputPersistence` is optional (`true`/`false`, defaults `false`) and enables MCP output persistence (see below).
- The file stores only these preference fields — no secrets, providers, permissions, shell, or arbitrary environment values; unknown fields are invalid.
- If the file is a symlink, has an unsupported version, or holds an invalid field, startup surfaces one diagnostic and falls back to lower-priority sources rather than blocking the TUI.

Effective source precedence (highest first): in-session `/theme` override → launch `--dark`/`--light` flag → project `.vesicle/preferences.yaml` → `VESICLE_THEME` env → built-in `default`.

`/theme` persistence grammar:

- `/theme dark|light|default|auto` — temporary current-session switch, no disk write.
- `/theme dark|light|default|auto --persist` — atomically write the project preference and apply it this session.
- `/theme --unset-project` — remove the project `theme`, clear the session override, and recompute by the precedence above.

`/new` and resuming another session clear the temporary session override and recompute the startup preference; theme never enters session JSONL.

## Project MCP output persistence (optional)

Set `mcpOutputPersistence: true` in `.vesicle/preferences.yaml` to persist every MCP tool call's text and image outputs under the project scratch root: text at `tmp/mcp-output/<session-id>/` and decoded images at `tmp/mcp-output/<session-id>/blob/`, as native files. Filenames derive from the MCP tool and its arguments so a listing stays greppable.

- The inline result the model receives is unchanged; persistence is an additive durable copy the model can re-read later with `read_file`, `grep_files`, and `view_image` instead of repeating an expensive or non-repeatable MCP call.
- Set `mcpOutputAutoTruncate: true` (requires `mcpOutputPersistence`) to replace oversized MCP text results (≥ 32 KiB) with a 4 KiB inline preview plus a reference to the persisted full copy, so one large result cannot dominate the context. Below the threshold the full body stays inline; either way the complete text is on disk.
- Off by default; applies only in the project where it is set. It is advertised to the model through a system-prompt hint only for engines that actually have MCP tools.
- Persisted outputs live in `tmp/`, which is not rewind-safe and is never auto-cleaned. Remove them with the file tools when no longer needed.

## Path resolution order, in short

Config directory resolves as: the directory of `VESICLE_PROVIDERS_FILE` → `VESICLE_CONFIG_DIR` → `%APPDATA%\prism-vesicle` → `$XDG_CONFIG_HOME/prism-vesicle` → `~/.config/prism-vesicle`.
