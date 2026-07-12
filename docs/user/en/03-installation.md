# 03 — Install Bun and Prism Vesicle

[← Previous: Model providers](./02-model-providers.md) | [Manual index](./README.md) | [简体中文](../zh-CN/03-installation.md) | [Next: Provider configuration →](./04-first-provider.md)

## What You Will Accomplish

You will install Bun, initialize the tutorial project, install Prism Vesicle locally, and verify that its bundled ETL engine assets can be read.

**Estimated time:** 15 minutes

**Prerequisites:** Chapters 00–02, an internet connection, and a normal PowerShell window

## Return to the Project Folder

Open Windows Terminal with PowerShell and run:

```powershell
Set-Location "$HOME\Documents\PrismVesicle\MyFirstProject"
```

## Check Whether Bun Is Installed

Run:

```powershell
bun --version
```

If PowerShell prints version `1.3.14` or newer, continue to “Initialize the Project.”

If PowerShell says that `bun` is not recognized, install Bun with the current official Windows installer command from [bun.sh](https://bun.sh/docs/installation):

```powershell
powershell -c "irm bun.sh/install.ps1|iex"
```

The command downloads and runs Bun's official installation script. After it finishes, close Windows Terminal completely, open it again, return to the project folder, and check the version:

```powershell
Set-Location "$HOME\Documents\PrismVesicle\MyFirstProject"
bun --version
```

If the command is still not recognized, restart Windows once and try again. Do not continue until `bun --version` succeeds.

## Initialize the Project

Run:

```powershell
bun init -y
```

This creates small project-management files such as `package.json`. You do not need to edit them during the beginner path.

## Install Prism Vesicle

Run:

```powershell
bun add prism-vesicle
```

Bun downloads Prism Vesicle and its runtime dependencies into the project. The first installation can take a few minutes.

Expected signs of success include a completed install summary and no final error message. The folder now contains `node_modules`, `package.json`, and `bun.lock`; these are normal program files.

## Verify the Bundled Engine Assets

Run:

```powershell
bunx vesicle prompt shape --engine etl
```

The first lines should resemble:

```text
Engine: etl (Prism ETL Engine)
Protocol: v9.0-state-space
System prompt length: ...
```

The exact prompt length and tool list can change between releases. Success means the command identifies the ETL engine and exits without an error.

## If Installation Fails

- Confirm that `bun --version` works in the same terminal.
- Confirm that `Get-Location` ends in `Documents\PrismVesicle\MyFirstProject`.
- Check your internet connection, VPN, proxy, or security software if the download cannot start.
- Run `bun add prism-vesicle` again after a temporary network failure.
- Copy the complete error text before closing the terminal if you need help.

## Completion Check

Run:

```powershell
bun --version
bunx vesicle prompt shape --engine etl
```

You are ready when Bun reports at least `1.3.14` and Vesicle reports `Engine: etl`.

[Next: Configure Your First Provider →](./04-first-provider.md)
