# 04 — Configure Your First Provider

[← Previous: Installation](./03-installation.md) | [Manual index](./README.md) | [简体中文](../zh-CN/04-first-provider.md) | [Next: Doctor and launch →](./05-doctor-and-launch.md)

## What You Will Accomplish

You will create Vesicle's Windows user configuration, connect it to one DeepSeek model, and store the API key outside the project folder.

**Estimated time:** 15 minutes

**Prerequisites:** Chapters 00–03, a DeepSeek API key, and the exact API model id you intend to use

## Create the User Configuration Folder

In PowerShell, run these commands one line at a time:

```powershell
$configDir = Join-Path $env:APPDATA "prism-vesicle"
New-Item -ItemType Directory -Force $configDir
```

`$env:APPDATA` is Windows' user-level application-data folder. `$configDir` is a temporary PowerShell variable that saves the full Vesicle configuration path for the rest of this terminal session.

## Create `providers.yaml`

Create the file and open it in Notepad:

```powershell
New-Item -ItemType File -Force (Join-Path $configDir "providers.yaml")
notepad (Join-Path $configDir "providers.yaml")
```

Copy this complete configuration into Notepad:

```yaml
default:
  provider: deepseek
  model: deepseek-v4-flash

providers:
  deepseek:
    protocol: openai-chat-compatible
    baseUrl: https://api.deepseek.com/v1
    apiKeyEnv: DEEPSEEK_API_KEY
    defaultModel: deepseek-v4-flash
    models:
      - id: deepseek-v4-flash
        capabilities:
          streaming: true
          tools: true
```

If your provider documentation gives a different API model id, replace every occurrence of `deepseek-v4-flash` with that exact id. It appears three times. Keep the indentation, punctuation, and capitalization of all other lines unchanged.

Save the file with Ctrl+S and close Notepad.

`providers.yaml` identifies the provider and model, but it does not contain the API key. YAML indentation uses spaces; do not replace them with Tab characters.

## Create the Secret `.env` File

Back in PowerShell, run:

```powershell
New-Item -ItemType File -Force (Join-Path $configDir ".env")
notepad (Join-Path $configDir ".env")
```

Type this line, replacing `YOUR_API_KEY` with the real key copied from the provider dashboard:

```dotenv
DEEPSEEK_API_KEY=YOUR_API_KEY
```

There should be no spaces around `=`. Save with Ctrl+S and close Notepad.

Never display this file while screen sharing, paste it into a support request, or copy it into the project folder. If the key is exposed, revoke it through the provider dashboard.

## Confirm the Files Exist

Run:

```powershell
Get-ChildItem $configDir -Force
```

The list should contain both:

```text
.env
providers.yaml
```

`-Force` allows PowerShell to show names that begin with a dot. This command displays file names, not the secret contents.

## Understand the Connection

The important fields are:

- `default.provider`: the provider Vesicle selects at startup
- `default.model`: the model selected at startup
- `protocol`: the API format used to communicate with the provider
- `baseUrl`: the provider's API endpoint
- `apiKeyEnv`: the name of the secret variable Vesicle must read from `.env`
- `models`: the allowed model ids for this provider

The name after `apiKeyEnv` must exactly match the name before `=` in `.env`.

## Completion Check

Confirm that:

- both files are under `%APPDATA%\prism-vesicle`, not inside `MyFirstProject`
- `providers.yaml` contains no real API key
- `.env` contains `DEEPSEEK_API_KEY=` followed by the real key
- the configured model id matches current provider API documentation

[Next: Run Doctor and Launch Vesicle →](./05-doctor-and-launch.md)
