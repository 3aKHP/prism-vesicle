# 05 — Run Doctor and Launch Vesicle

[← Previous: Provider configuration](./04-first-provider.md) | [Manual index](./README.md) | [简体中文](../zh-CN/05-doctor-and-launch.md) | [Next: First conversation →](./06-first-conversation.md)

## What You Will Accomplish

You will inspect the saved configuration with Vesicle Doctor, launch any project from its own directory, and exit the terminal interface safely.

**Estimated time:** 5 minutes

**Prerequisites:** Chapters 00–04 and a completed guided Setup

## Run Doctor

Open the Windows Start Menu, find **Prism Vesicle**, and select **Prism Vesicle Doctor**. The diagnostic window remains open so you can read or copy its output.

Doctor inspects the runtime, selected provider and model, user configuration, API-key availability, optional Tavily and MCP services, permissions, and the installed Harness. It reports status without printing secret values.

Important lines should resemble:

```text
Prism Vesicle Doctor
Provider: example
Protocol: openai-chat-compatible
Model: selected-model
Provider config: file (...\prism-vesicle\providers.yaml)
Provider env: file (...\prism-vesicle\.env)
API key: available
Permissions: MOMENTUM (...\permissions.yaml)
Shell exec: disabled; interpreter PowerShell 7 (...\pwsh.exe)
Harness: bundled prism-engine-v10@10.0.1-alpha.3
Missing: none
```

Optional Tavily or MCP lines may report unavailable, disabled, or a server-specific connection error. Those results do not invalidate the provider unless your intended workflow requires those tools. The Shell exec line reports both capability state and the resolved `shellInterpreter`; an unavailable explicit profile keeps shell tools out of the model tool surface until the configuration is corrected.

## Correct a Problem

If Doctor reports a missing provider configuration, API key, or model, close the diagnostic window and open **Configure Prism Vesicle** from the Start Menu. The wizard merges corrected settings and backs up changed existing files; do not repair YAML by hand during the beginner path.

For an MCP connection error, reopen Setup and edit or retry that server. For an unavailable Tavily key, reopen Setup and configure it or intentionally leave it skipped.

Do not continue until the required provider lines report `API key: available` and `Missing: none`.

## Launch A Project

Vesicle does not store one global project. Open PowerShell 7, enter the intended project directory, and launch that directory:

```powershell
Set-Location "$HOME\Documents\PrismVesicle\MyFirstProject"
vesicle .
```

Alternatively, right-click the project folder or its empty background in File Explorer and choose **Open in Prism Vesicle**. On Windows 11 this action may appear under **Show more options**.

The terminal changes into Vesicle's full-screen interface. You should see a conversation area, status information, and an input composer near the bottom.

## Exit and Launch Again

Press Ctrl+Q. Vesicle closes and returns to the terminal or closes the application window. If a modal panel owns the keyboard, press Escape to close the panel and then press Ctrl+Q again.

Run `vesicle .` from the same folder again, or use its Explorer action. Leave it open for the next chapter.

## Completion Check

You are ready when:

- Doctor reports the intended provider and model;
- `API key: available` and `Missing: none` appear for the required setup;
- `vesicle .` opens the TUI in the current project directory;
- Ctrl+Q exits safely.

[Next: Complete Your First Conversation →](./06-first-conversation.md)
