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
Protocol: v10.0-tempered-voice
System prompt length: ...
```

The exact prompt length and tool list can change between releases. Success means the command identifies the ETL engine and exits without an error.

Now inspect where those assets came from:

```powershell
bunx vesicle assets status
```

For the normal installation in this chapter, `Bundled` should report 47 files, `Host` should report 12 files, and `Active baseline` should identify bundled `prism-engine-v10@10.0.1-alpha.1`. Vesicle can also read user-global overrides from `%APPDATA%\prism-vesicle\assets\` and sparse overrides from `assets\` inside the current project. You do not need to create either override or a Harness lock.

## Optional: Select an Offline Harness Pack

The normal installation already runs complete V10. Advanced users can select a different independently released Harness Pack after extracting it to a local directory. Verification and installation do not activate the pack:

```powershell
bunx vesicle assets verify "C:\Downloads\prism-vesicle-harness-v10"
bunx vesicle assets install "C:\Downloads\prism-vesicle-harness-v10"
bunx vesicle assets use "<pack-id>@<version>"
bunx vesicle assets status
```

`use` writes `.vesicle\assets.lock.json` in the current project. Vesicle reverifies that exact installed pack whenever the project starts or a session resumes. A session recorded under a different Harness identity is blocked instead of being switched silently.

To return the project to the bundled V10 baseline, run:

```powershell
bunx vesicle assets rollback
```

This first offline flow requires an already-extracted Release directory. It does not download, discover, extract, or automatically update Harness Packs.

Sessions created by an older V9-only Vesicle build do not contain a Harness identity and cannot resume under bundled V10. Start a new session after upgrading.

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
