# Prism Vesicle User Manual

[English](./README.md) | [简体中文](../zh-CN/README.md)

This manual teaches Prism Vesicle from first principles. It assumes that you may be new to terminals, configuration files, API keys, and AI model providers.

The main path uses Windows 11, Windows Terminal, and PowerShell. Linux and WSL users can still follow the product concepts, but platform-specific commands are intentionally kept out of the beginner path.

## How To Use This Manual

Read the numbered chapters in order. Each chapter introduces only the concepts needed for its task, shows the interaction to complete, explains the expected result, and ends with a completion check.

Chapters `00`–`06` form the first complete learning path: understand the product, prepare Windows, install Vesicle, configure one provider, pass Doctor, and complete a first conversation.

## Beginner Path

1. [00 — Welcome and Safety](./00-welcome.md)
2. [01 — Windows, Files, and PowerShell](./01-windows-basics.md)
3. [02 — Model Providers, API Keys, Cost, and Privacy](./02-model-providers.md)
4. [03 — Install Prism Vesicle](./03-installation.md)
5. [04 — Configure Your First Provider in Guided Setup](./04-first-provider.md)
6. [05 — Run Doctor and Launch Vesicle](./05-doctor-and-launch.md)
7. [06 — Complete Your First Conversation](./06-first-conversation.md)

## Everyday Use

8. [07 — Models and Prism Engines](./07-models-and-engines.md)
9. [08 — Sessions and Resume](./08-sessions-and-resume.md)

## Prism Workflows

10. [09 — A Complete ETL Workflow](./09-complete-etl-workflow.md)

## Advanced Operation

11. [10 — Tool Permissions and the Host Shell](./10-tool-permissions-and-shell.md)

## Planned Learning Path

The following chapters will extend the manual from everyday use to advanced operation:

- `11` — Artifacts and validation
- `12` — Gates, questions, and engine handoffs
- `13` — Rewind and file checkpoints
- `14` — Context, compaction, effort, and reasoning
- `15` — Images and web research
- `16` — MCP tools
- `17` — Advanced provider configuration
- `18` — Troubleshooting and recovery
- `19` — Updates, backups, migration, and removal

Reference pages for commands, configuration, terminology, and frequently asked questions will be added separately from the numbered learning path.

## Manual Status

Prism Vesicle is currently an alpha product. The manual documents the supported onboarding path, but screens, commands, provider models, and workflow details may change. When the manual and the program disagree, run `vesicle doctor`, record the exact command and output, and report the mismatch.

[Start with Chapter 00 →](./00-welcome.md)
