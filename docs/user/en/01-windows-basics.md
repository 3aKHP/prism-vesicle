# 01 — Windows, Files, and PowerShell

[← Previous: Welcome](./00-welcome.md) | [Manual index](./README.md) | [简体中文](../zh-CN/01-windows-basics.md) | [Next: Model providers →](./02-model-providers.md)

## What You Will Accomplish

You will open PowerShell, learn the few file and folder concepts needed by Vesicle, and create the project folder used by the rest of the beginner path.

**Estimated time:** 15 minutes

**Prerequisites:** Chapter 00

## Files, Folders, and Paths

A file stores content, such as a document or configuration. A folder groups files and other folders. A path tells Windows where a file or folder is located.

For example:

```text
C:\Users\YourName\Documents\PrismVesicle\MyFirstProject
```

You do not need to type your Windows account name in the tutorial. PowerShell provides `$HOME`, which points to your user folder automatically.

Vesicle uses two different locations:

- The **project folder** contains the work for one project, including generated artifacts and local session data.
- The **user configuration folder** at `%APPDATA%\prism-vesicle` contains provider settings and secrets shared by your Vesicle projects.

Keeping these locations separate prevents API keys from being copied into project folders.

## Open Windows Terminal

1. Open the Windows Start menu.
2. Type `Terminal`.
3. Open **Windows Terminal**.
4. Confirm that the tab title says PowerShell and does not say Administrator.

If Windows Terminal is unavailable, an ordinary PowerShell window can complete the tutorial. PowerShell 7 inside Windows Terminal is recommended because it provides the clearest modern experience.

## Run Your First Command

Type or paste:

```powershell
Get-Location
```

Press Enter. PowerShell prints the current folder. The exact path is different for every user.

A command is an instruction to the terminal. PowerShell waits for a command, runs it after you press Enter, prints any result, and then waits for the next command.

## Create the Tutorial Project Folder

Paste these commands one line at a time:

```powershell
New-Item -ItemType Directory -Force "$HOME\Documents\PrismVesicle\MyFirstProject"
Set-Location "$HOME\Documents\PrismVesicle\MyFirstProject"
Get-Location
```

The final command should print a path ending in:

```text
Documents\PrismVesicle\MyFirstProject
```

`New-Item` creates the folder. `Set-Location` moves the terminal into it. The current folder matters because Vesicle stores project sessions and generated files relative to the folder from which you launch it.

## Look Inside the Folder

Run:

```powershell
Get-ChildItem
```

The folder should currently be empty, so PowerShell may print nothing. That is a successful result.

You can also open the current folder in File Explorer:

```powershell
explorer .
```

The dot means “the current folder.”

## Basic Terminal Controls

- Press Enter to run the current command.
- Use the Up and Down arrow keys to recall earlier commands.
- Press Tab to complete part of a file or folder name.
- Press Ctrl+C to stop a command that is still running.
- Use Ctrl+Shift+C and Ctrl+Shift+V in Windows Terminal if ordinary copy and paste shortcuts are intercepted by a terminal program.

Closing the terminal does not delete files. When you open a new terminal later, use `Set-Location "$HOME\Documents\PrismVesicle\MyFirstProject"` to return to the tutorial project.

## Completion Check

Run both commands:

```powershell
Get-Location
Get-ChildItem
```

You are ready when the location ends in `Documents\PrismVesicle\MyFirstProject`. The folder may still be empty.

[Next: Model Providers, API Keys, Cost, and Privacy →](./02-model-providers.md)
