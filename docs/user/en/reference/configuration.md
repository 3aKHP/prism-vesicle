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

Files in that directory:

| File | Required | Contents |
|---|---|---|
| `providers.yaml` | Yes | Providers, models, protocols, endpoints, `apiKeyEnv` names |
| `.env` | Yes | The corresponding secret values |
| `mcp.yaml` | No | Optional MCP tool servers |
| `permissions.yaml` | No | Tool-approval default and the `shell_exec` switch (see [permissions](./permissions-and-security.md)) |
| `quality.yaml` | No | Experimental Semantic Judge |
| `assets/` | No | User-level asset overrides |

> Do not rely on a project-root `.env`. If an old one remains, move its values into the user directory above and remove it.

## providers.yaml

For the full canonical shape, see [`docs/examples/providers.yaml`](../../../examples/providers.yaml). Structure highlights:

```yaml
default:               # provider and model selected at startup
  provider: deepseek
  model: deepseek-v4-flash

providers:
  deepseek:
    protocol: openai-chat-compatible   # or anthropic-messages / gemini-generate-content
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

- `protocol`: one of `openai-chat-compatible`, `anthropic-messages`, `gemini-generate-content`.
- `apiKeyEnv`: **the environment-variable name only**; the real secret goes in `.env`. `providers.yaml` itself never holds secrets.
- `authMethod`: `x-api-key` for Anthropic, `x-goog-api-key` for Gemini.
- `userAgent` (optional): replaces the User-Agent for this provider only; other fingerprint and auth headers stay fixed.
- A model entry can be a string shorthand or an object with `generation` (`temperature`/`maxTokens`), `capabilities` (`streaming`/`tools`/`vision`/`reasoningTier`/`reasoningContent`), and `limits` (`contextWindow`/`maxOutputTokens`/`autoCompact`).
- `limits.contextWindow` enables the context percentage in the status bar; `autoCompact` controls the auto-compact threshold and output reserve.

## .env

Put values here for every `apiKeyEnv` named in `providers.yaml`. Start from [`docs/examples/provider.env.example`](../../../examples/provider.env.example):

```text
DEEPSEEK_API_KEY=
ANTHROPIC_API_KEY=
GEMINI_API_KEY=
LOCAL_OPENAI_COMPAT_API_KEY=
TAVILY_API_KEY=
MCP_CLUSTER_TOKEN=
```

`TAVILY_API_KEY` enables the web research tools for the ETL/Evaluate engines; MCP auth tokens also go here. Process environment variables are a fallback only.

## Providers and cost (for beginners)

- An **API key** is a string you get from a model provider (DeepSeek, Anthropic, Google, or a local compatible service) that identifies your account.
- The **Base URL** is that provider's endpoint address; Vesicle sends requests to it.
- **Cost** is billed by the provider by usage (tokens); Vesicle itself charges nothing. Model prices vary widely — when unsure, try a cheaper model first.
- Local models (such as Ollama) connect through an OpenAI-compatible endpoint; point the Base URL at `http://127.0.0.1:<port>/v1`.

## mcp.yaml (optional)

Start from [`docs/examples/mcp.yaml`](../../../examples/mcp.yaml). Each server can set `transport` (streamable-http), `url`, `timeoutSeconds`, `toolPrefix`, `headers` (supports `${ENV_VAR}` expansion from `.env`), `includeTools`/`excludeTools` filters, and `enabledEngines` (which engines can use it). A present `mcp.yaml` defaults to enabled; secrets go in `.env`.

## Path resolution order, in short

Config directory resolves as: the directory of `VESICLE_PROVIDERS_FILE` → `VESICLE_CONFIG_DIR` → `%APPDATA%\prism-vesicle` → `$XDG_CONFIG_HOME/prism-vesicle` → `~/.config/prism-vesicle`.
