<!-- Generated from docs/user/en/README.md — do not edit. -->

# Prism Vesicle User Manual

English | [简体中文](../zh-CN/README.md)

Prism Vesicle is a terminal host for Prism Engine creative workflows: it connects to your own model API and turns source material into structured character cards, scenario cards, and long-form narrative.

## Start here: how did you get Vesicle?

| I have… | Good for | Start page |
|---|---|---|
| The Windows installer (`PrismVesicleSetup-<version>-windows-x64.exe`) | First time with a terminal program; want a guided wizard | [Windows installer](./start/windows-installer.md) |
| The npm package (`prism-vesicle`) | A developer already using Bun | [npm install](./start/npm.md) |
| The Windows single-file build (`prism-vesicle-windows-x64-<version>.exe` + asset pack) | Don't want an installer; need no-install or self-verification | [Windows portable](./start/windows-portable.md) |
| The Linux single-file build (`prism-vesicle-linux-x64-<version>` + asset pack) | Linux / WSL users | [Linux portable](./start/linux-portable.md) |

> Other Linux packages such as `.deb` are not published yet; a row will be added when they are.

Not sure which? A Windows user with no history here is best off with the installer.

## After that (every start page converges)

Whichever entry you use, the destination is the same: `vesicle doctor` passes, and Vesicle is open in your project directory. Then continue from one shared tutorial path:

1. [First conversation](./tutorials/first-conversation.md)
2. [View and edit artifacts in the Workspace page](./tutorials/workspace-page.md)
3. [Keep working during a turn](./tutorials/work-while-running.md)
4. … (full contents in the [tutorial index](./tutorials/README.md))

## What do I want to do now?

You do not need to read the whole manual in order. Jump to the task in front of you:

| I want to… | Start here |
|---|---|
| Configure a model or API key, or fix startup checks | Your [installation start page](#start-here-how-did-you-get-vesicle), then [Configuration files](./reference/configuration.md) |
| Start my first creative task and understand confirmation panels | [First conversation](./tutorials/first-conversation.md) |
| Choose between ETL, Runtime, Evaluate, Weaver, Dyad, and other Engines | [Choose an Engine](./advanced/engines.md) |
| View, edit, validate, or recover a file | [Workspace page](./tutorials/workspace-page.md) |
| Let the model search the web or inspect an image | [Web search and images](./tutorials/web-search-and-images.md) |
| Resume, regenerate, switch branches, or compact context | [Sessions and rewind](./tutorials/sessions-and-rewind.md) |
| Keep repeated rules for future sessions | [Persistent Instructions](./tutorials/persistent-instructions.md) |
| Let the model use a documentation Skill or delegate to a SubAgent | [Skills and SubAgents](./tutorials/skills-and-subagents.md) |
| Start continuous narrative play from two cards | [Stage consumer engine](./advanced/stage.md) |
| Connect an external MCP tool | [MCP tools](./advanced/mcp.md) |
| Manage Harness Packs or switch the creative baseline | [Harness Packs](./advanced/harness-packs.md) |
| Look up every terminal command or TUI key | [Terminal command reference](./reference/cli-commands.md) / [TUI command cheatsheet](./reference/commands.md) |

## Reference

Command cheatsheet, configuration files, the permission and security model, checksums and signing, updates and uninstall, and troubleshooting live in the [reference section](./reference/README.md).

## Advanced and experimental

Host shell, Output Quality Guard, SubAgents, Stage, MCP tools, Harness Packs, and other advanced capabilities live in the [advanced section](./advanced/README.md).

## Manual status

Prism Vesicle is in beta; the interface and commands may still change. `vesicle doctor` diagnoses the environment, but it is not a description of every feature. When the manual disagrees with the real interface or command, retain the exact error and use [Troubleshooting](./reference/troubleshooting.md) to report the discrepancy.
