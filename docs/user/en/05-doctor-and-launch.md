# 05 — Run Doctor and Launch Vesicle

[← Previous: Provider configuration](./04-first-provider.md) | [Manual index](./README.md) | [简体中文](../zh-CN/05-doctor-and-launch.md) | [Next: First conversation →](./06-first-conversation.md)

## What You Will Accomplish

You will use Vesicle Doctor to check the installation and configuration, understand the important results, and open and exit the terminal interface safely.

**Estimated time:** 10 minutes

**Prerequisites:** Chapters 00–04

## Return to the Project Folder

Open Windows Terminal with PowerShell and run:

```powershell
Set-Location "$HOME\Documents\PrismVesicle\MyFirstProject"
```

## Run Doctor

Run:

```powershell
bunx vesicle doctor
```

Doctor inspects the runtime, project folder, selected provider and model, configuration files, API key availability, and optional host tools. It reports whether required pieces are missing without printing the API key itself.

Important lines should resemble:

```text
Prism Vesicle Doctor
Bun: 1.3.14
Provider: deepseek
Protocol: openai-chat-compatible
Model: deepseek-v4-flash
Provider config: file (...\prism-vesicle\providers.yaml)
Provider env: file (...\prism-vesicle\.env)
API key: available
Assets project: missing (...\MyFirstProject\assets)
Assets user: missing (...\prism-vesicle\assets)
Assets bundled: 47 files (...\node_modules\prism-vesicle\assets)
Assets host: 12 files (...\node_modules\prism-vesicle\host-assets)
Harness: bundled prism-engine-v10@10.0.1-alpha.1
Missing: none
```

Your Bun version and model id may differ. Optional Tavily or MCP lines may say unavailable or disabled; that does not block the first conversation.

Asset paths may differ. `project` and `user` may be missing because they are optional override layers; the required condition is that Doctor verifies the bundled or managed Harness baseline. A normal installation uses the bundled V10 Harness without a project lock.

## Read Common Doctor Problems

### Provider config not found

Confirm that the file is exactly `%APPDATA%\prism-vesicle\providers.yaml`, not `providers.yaml.txt`. Return to Chapter 04 and recreate it with the PowerShell commands if necessary.

### Provider env not found

Confirm that the secret file is exactly `%APPDATA%\prism-vesicle\.env`, not `.env.txt`.

### API key missing

Open `.env` again and confirm that the variable name exactly matches `apiKeyEnv` in `providers.yaml` and has a value after `=`.

### Unknown or invalid model configuration

Check that the same model id appears under `default.model`, `defaultModel`, and `models`. YAML spaces and indentation must match the example.

Do not proceed until Doctor ends with `Missing: none` for the required provider setup.

## Launch Vesicle

Run:

```powershell
bunx vesicle
```

The terminal changes into Vesicle's full-screen interface. You should see a conversation area, status information, and an input composer near the bottom.

The first screen may mention the active provider and model, the ETL engine, or existing sessions. This is normal.

## Exit Vesicle

Press Ctrl+Q. Vesicle closes and returns you to the ordinary PowerShell prompt.

If Ctrl+Q does not work because another panel owns the keyboard, press Escape to close the panel and then press Ctrl+Q again. Avoid closing the whole terminal while Vesicle is writing a response or file.

## Launch It Again

Run the same command:

```powershell
bunx vesicle
```

This confirms that Vesicle can start repeatedly from the project folder. Leave it open for the next chapter.

## Completion Check

You are ready when:

- Doctor reports the intended provider and model
- `API key: available` appears
- required configuration ends with `Missing: none`
- the TUI opens successfully
- you know that Ctrl+Q exits the application

[Next: Complete Your First Conversation →](./06-first-conversation.md)
