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
2. [Keep working during a turn](./tutorials/work-while-running.md)
3. … (full contents in the [tutorial index](./tutorials/README.md))

## Reference

Command cheatsheet, configuration files, the permission and security model, checksums and signing, updates and uninstall, and troubleshooting live in the [reference section](./reference/README.md).

## Advanced and experimental

Host shell, Output Quality Guard, SubAgents, Stage, and other advanced capabilities live in the [advanced section](./advanced/README.md).

## Manual status

Prism Vesicle is in alpha; the interface and commands may change. When the manual disagrees with the program, trust `vesicle doctor` and please report the discrepancy.
