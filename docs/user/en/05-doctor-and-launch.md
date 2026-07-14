# 05 — Run Doctor and Launch Vesicle

[← Previous: Provider configuration](./04-first-provider.md) | [Manual index](./README.md) | [简体中文](../zh-CN/05-doctor-and-launch.md) | [Next: First conversation →](./06-first-conversation.md)

## What You Will Accomplish

You will inspect the saved configuration with Vesicle Doctor, launch the selected project from the Start Menu, and exit the terminal interface safely.

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
Harness: bundled prism-engine-v10@10.0.1-alpha.1
Missing: none
```

Optional Tavily or MCP lines may report unavailable, disabled, or a server-specific connection error. Those results do not invalidate the provider unless your intended workflow requires those tools.

## Correct a Problem

If Doctor reports a missing provider configuration, API key, or model, close the diagnostic window and open **Configure Prism Vesicle** from the Start Menu. The wizard merges corrected settings and backs up changed existing files; do not repair YAML by hand during the beginner path.

For an MCP connection error, reopen Setup and edit or retry that server. For an unavailable Tavily key, reopen Setup and configure it or intentionally leave it skipped.

Do not continue until the required provider lines report `API key: available` and `Missing: none`.

## Launch Vesicle

Open **Prism Vesicle** from the Start Menu. It launches in the project directory saved by Setup. If no project has been configured yet, it opens the guided Setup instead.

The terminal changes into Vesicle's full-screen interface. You should see a conversation area, status information, and an input composer near the bottom.

## Exit and Launch Again

Press Ctrl+Q. Vesicle closes and returns to the terminal or closes the application window. If a modal panel owns the keyboard, press Escape to close the panel and then press Ctrl+Q again.

Open **Prism Vesicle** from the Start Menu again. It should return to the same configured project. Leave it open for the next chapter.

## Completion Check

You are ready when:

- Doctor reports the intended provider and model;
- `API key: available` and `Missing: none` appear for the required setup;
- the TUI opens from the Start Menu in the selected project;
- Ctrl+Q exits safely.

[Next: Complete Your First Conversation →](./06-first-conversation.md)
