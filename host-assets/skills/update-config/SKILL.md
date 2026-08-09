---
name: update-config
description: "Configure Prism Vesicle providers, permissions, preferences, MCP, quality, and proxy settings through guided, validated CLI operations. Use when the user wants to add, change, or remove a provider/model, toggle shell_exec or permission mode, set a theme or MCP output persistence, configure a provider proxy, or inspect current configuration state. Never handles API keys or secret values directly."
---

# update-config

Configure Prism Vesicle through a set of validated, atomic CLI operations. You can inspect current configuration state, add or modify providers, toggle permissions and preferences, and manage non-secret environment variables — all through the `update_config` wrapper script.

## When to activate

Activate when the user asks to:
- Add, remove, or change a provider or model
- Switch the default provider or model
- Change permission mode or toggle shell_exec
- Set a project theme preference
- Toggle MCP output persistence or auto-truncation
- Configure or remove a provider proxy
- Set the external editor
- Change quality guard mode
- Inspect or validate current configuration

Do not activate for general "how do I use Vesicle" questions (use vesicle-docs instead) or for workflow capture (use skillify).

## Security rules — read first

**Secret values are never your responsibility.** API keys, tokens, and credentials are stored in the user-level `.env` file. You must never:
- Read, repeat, or display actual secret values
- Accept secret values as script arguments
- Write secret values to any file
- Use a secret value shared in the conversation

The `.env` file also stores non-secret values (like `VESICLE_PROVIDER_PROXY`). You can manage its **structure** — which variables exist, which are empty — but never its secret contents.

### When the user shares a credential in conversation

If the user pastes an API key, token, or password directly in the chat:
1. Tell them: "You have shared a credential in this conversation. It has been recorded in the session transcript and sent to the model provider. I will not store, repeat, or use it. If this is a real key, consider rotating it in your provider's console."
2. Do not echo the credential back.
3. Do not attempt to use it for configuration.
4. Guide them to configure it safely: "To set your API key, edit the `.env` file at the config directory and paste the key after the `=` sign. I can help with everything else."

### Proxy URLs with credentials

If the user provides a proxy URL containing credentials (`http://user:pass@proxy:8080`), guide them to edit `.env` manually instead of passing the full URL through the conversation. For proxy URLs without credentials, you can use `env-set-proxy` normally.

## Procedure

1. **Understand the intent.** What does the user want to achieve? Common goals: add a provider, switch models, enable a feature, fix a config issue.

2. **Inspect current state.** Run the appropriate `show` command to see what exists:
   - `show providers` — provider registry (protocols, models, defaults)
   - `show env` — sanitized .env view (which variables exist, never their values)
   - `show permissions` — permission mode and shell_exec state
   - `show preferences` — project theme and MCP output settings
   - `show quality` — quality guard configuration
   - `show settings` — host settings (editor)
   - `show mcp` — MCP server configuration

3. **Propose the change.** Tell the user exactly what you will modify and why. For provider additions, confirm the protocol, base URL, model IDs, and whether a Responses profile is needed.

4. **Execute.** Run the wrapper script with the appropriate subcommand.

5. **Report the result.** Summarize what changed, show the output, and remind the user to restart Vesicle if `restartRequired` is true.

6. **Validate** (optional). Run `validate` to confirm all config files parse correctly.

## Wrapper usage

Use `scripts/update_config.sh` on POSIX systems and `scripts/update_config.ps1` on Windows. Both accept the same arguments and pass them through to `vesicle config`.

### Available operations

```
# Information
update_config.sh path                          # Config directory path
update_config.sh show <target>                 # Read config (sanitized)
update_config.sh validate                      # Validate all config files

# Provider management
update_config.sh set providers default.provider <id>
update_config.sh set providers default.model <id>
update_config.sh add-provider --json '<entry>'

# Permissions
update_config.sh set permissions defaultMode <MANUAL|INERTIA|MOMENTUM>
update_config.sh set permissions shellExec <true|false>

# Project preferences
update_config.sh set preferences theme <dark|light|default|auto>
update_config.sh set preferences mcpOutputPersistence <true|false>
update_config.sh set preferences mcpOutputAutoTruncate <true|false>

# Quality guard
update_config.sh set quality mode <off|observe|rewrite>

# Host settings
update_config.sh set settings editor <command>

# .env (non-secret operations only)
update_config.sh env-set-empty <KEY>           # Create empty variable slot
update_config.sh env-set-proxy <URL>           # Set provider proxy URL
update_config.sh env-remove <KEY>              # Remove a variable
```

### Adding a provider

The `add-provider` operation takes a JSON entry:

```json
{
  "id": "my-provider",
  "protocol": "openai-chat-compatible",
  "baseUrl": "https://api.example.com/v1",
  "apiKeyEnv": "MY_PROVIDER_API_KEY",
  "models": [{"id": "model-1"}, {"id": "model-2"}],
  "defaultModel": "model-1"
}
```

The CLI validates the entry, adds the provider to `providers.yaml`, and creates an empty `MY_PROVIDER_API_KEY=` slot in `.env`. Tell the user to edit `.env` and paste their API key after the `=` sign, then restart Vesicle.

For OpenAI Responses providers, include `responsesProfile` and optionally `responsesTransport`:
```json
{
  "id": "openai",
  "protocol": "openai-responses",
  "responsesProfile": "openai-public",
  "baseUrl": "https://api.openai.com/v1",
  "apiKeyEnv": "OPENAI_API_KEY",
  "models": [{"id": "gpt-5.5"}],
  "defaultModel": "gpt-5.5"
}
```

### After adding a provider

1. The provider is in `providers.yaml` with the correct protocol and models.
2. The `apiKeyEnv` variable exists in `.env` with an empty value.
3. **The user must edit `.env` to paste their API key.** You cannot and must not do this for them.
4. Tell the user: "Your provider is configured. Edit `.env` at the path shown, paste your API key after `=`, save, and restart Vesicle."

## Boundaries

- You cannot read, write, or display secret values. The `.env` sanitization is enforced by the CLI, not by your discipline.
- You cannot add MCP servers (edit `mcp.yaml` manually for now).
- You cannot modify `VESICLE.md` persistent instructions (use the `update_instructions` tool or `/instructions` command).
- You cannot change Engine profiles, Harness packs, or session state.
- You cannot validate provider connectivity — configuration changes take effect after restart; suggest the user run `vesicle doctor` or send a test message.
- All writes are atomic and validated by re-parsing. A failed write leaves the original file unchanged.
