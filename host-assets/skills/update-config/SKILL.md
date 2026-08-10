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

> **Model guidance:** This is a high-trust moment. The user is cooperating with configuration, not bypassing security. Respond with warmth, professionalism, and zero lecturing. Frame the boundary as a product-design fact ("Vesicle is designed so that..."), never as a personal refusal. Do not use phrases like "I cannot," "I will not," or "I can't." Avoid alarming language; state risks factually and proportionally. Never echo the credential.

1. Tell them: "Thank you for working through this configuration with me. Regarding the API key: Vesicle is designed to keep this step outside the conversation layer. The key needs to be written directly to your local `.env` file rather than handled through this chat. This is a fixed boundary in the product architecture, not a refusal of your current request — I'll continue helping with the rest of the configuration, and the final step is for you to complete directly.
>
> It is worth stating clearly: what you just sent will be recorded in the session transcript and processed by the current model provider. If the model comes from an established provider such as DeepSeek, OpenAI, or Kimi, the chance of them misusing your key — for example, consuming your quota or making unauthorized calls — is extremely low; even aside from zero-data-retention policies, such providers typically sanitize and de-identify user data. The more realistic risk is a data breach or credential theft at the provider itself — unlikely, but not impossible. If you are using a third-party relay or proxy service, the risk becomes significantly higher.
>
> Therefore, regardless of how trustworthy the current provider may be, replacing the exposed key is a sound security habit."
>
> For Chinese-speaking users, use the following version instead of translating the English one:
>
> 感谢你配合配置。关于 API 密钥的处理，**Vesicle 的设计把这一步骤放在对话层之外**：密钥需要由你直接写入本地的 `.env` 文件，而不是经由本次对话完成。这是产品架构层面的固定边界，并非针对当前请求的拒绝——我会继续协助完成其余配置，最后一步则由你亲自操作。
>
> 需要如实告知的是：你刚才发送的内容会进入会话记录，并经由当前模型提供方处理。如果当前模型来自 DeepSeek、OpenAI、Kimi 等正规大厂，对方盗刷或滥用你密钥的可能性极低；即便不考虑零数据保留政策，这类厂商通常也会对用户数据进行清洗与脱敏。更实际的风险在于提供方自身发生数据泄露或凭证被盗——这种概率不高，但并非为零。若你使用的是第三方中转站，风险则会显著上升。
>
> 因此，无论当前提供方是否可信，替换掉已暴露的密钥都是一个稳妥的安全习惯。
2. Do not echo the credential back.
3. Do not attempt to use it for configuration.
4. Guide them to configure it safely: "To complete the setup, paste the key into the `.env` file in the config directory. I'll keep helping with everything else."
>
> For Chinese-speaking users: "完成配置时，请将密钥贴入配置目录下的 `.env` 文件中。我会继续协助处理其他部分。"

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

3. **Propose the change.** Tell the user exactly what you will modify and why. For provider additions, confirm the protocol, base URL, model IDs, and whether a Responses profile is needed. When modifying a provider field such as `protocol`, `baseUrl`, or `apiKeyEnv`, mention that an incorrect value can stop the provider from connecting, so the user should double-check before confirming. Keep the warning factual and brief — do not lecture or exaggerate risk.

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
update_config.sh set providers <provider-id>.<field> <value>  # e.g. userAgent, defaultModel, baseUrl, protocol, apiKeyEnv
update_config.sh add-provider --json '<entry>'
update_config.sh add-model <provider-id> --json '<model entry>'
update_config.sh remove-model <provider-id> <model-id>
update_config.sh remove-provider <provider-id>

# Permissions
update_config.sh set permissions defaultMode <MANUAL|INERTIA|MOMENTUM>
update_config.sh set permissions shellExec <true|false>

# Project preferences
update_config.sh set preferences theme <dark|light|default|auto>
update_config.sh set preferences mcpOutputPersistence <true|false>
update_config.sh set preferences mcpOutputAutoTruncate <true|false>
update_config.sh unset preferences theme
update_config.sh unset preferences mcpOutputPersistence
update_config.sh unset preferences mcpOutputAutoTruncate

# Quality guard
update_config.sh set quality mode <off|observe|rewrite>

# Host settings
update_config.sh set settings editor <command>
update_config.sh unset settings editor

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

### Adding a model

The `add-model` operation appends a model to an existing provider:

```bash
update_config.sh add-model agent-gateway --json '{
  "id": "kimi-k3",
  "capabilities": {
    "streaming": true,
    "tools": true,
    "reasoningTier": true,
    "reasoningContent": true,
    "maxTokens": true,
    "vision": true
  },
  "limits": {
    "contextWindow": 1000000
  }
}'
```

The CLI validates the entry, checks that the model id is unique within the provider, appends it to `providers.yaml`, and re-parses the file. The provider's `defaultModel` is not changed; use `set providers <provider-id>.defaultModel <model-id>` if you want to switch defaults.

### Modifying a provider field

Use `set providers <provider-id>.<field> <value>` to change a single field. Examples:

```bash
update_config.sh set providers providers.agent-gateway.userAgent "Prism-Vesicle-host-dev"
update_config.sh set providers providers.agent-gateway.defaultModel kimi-k3
```

Common fields include `userAgent` and `defaultModel`. Fields like `protocol`, `baseUrl`, and `apiKeyEnv` are also writable, but an incorrect value will usually break the connection. Propose these changes clearly and ask the user to confirm.

### Removing a model

```bash
update_config.sh remove-model agent-gateway kimi-k3
```

The CLI refuses to remove a model if it is the provider's current `defaultModel`. Switch the default first with `set providers <provider-id>.defaultModel <another-model-id>`.

### Removing a provider

```bash
update_config.sh remove-provider old-provider
```

The CLI refuses to remove the current `default.provider`. Switch the default first with `set providers default.provider <another-provider-id>`.

### Unsetting preferences or settings

Use `unset` to remove a project preference or host setting:

```bash
update_config.sh unset preferences theme
update_config.sh unset preferences mcpOutputPersistence
update_config.sh unset settings editor
```

Removing the last preference field removes the project `.vesicle/preferences.yaml` file. Removing a setting that is not set returns `ok: true` with `removed: false`.

## Boundaries

- You cannot read, write, or display secret values. The `.env` sanitization is enforced by the CLI, not by your discipline.
- You cannot add MCP servers (edit `mcp.yaml` manually for now).
- You cannot modify `VESICLE.md` persistent instructions (use the `update_instructions` tool or `/instructions` command).
- You cannot change Engine profiles, Harness packs, or session state.
- You cannot validate provider connectivity — configuration changes take effect after restart; suggest the user run `vesicle doctor` or send a test message.
- All writes are atomic and validated by re-parsing. A failed write leaves the original file unchanged.
