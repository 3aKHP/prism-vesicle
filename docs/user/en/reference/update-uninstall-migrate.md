# Update · uninstall · migrate

English | [简体中文](../../zh-CN/reference/update-uninstall-migrate.md)

Vesicle's **user configuration** and **project data** are stored separately from the program, so upgrades and uninstalls leave them untouched.

- User configuration: the user directory in [Configuration files](./configuration.md) (Windows `%APPDATA%\prism-vesicle\`, Linux `~/.config/prism-vesicle/`).
- Project data: each project directory's `.vesicle/` (sessions, file checkpoints, and so on), following the project.

## Windows installer

Run `PrismVesicleSetup-<version>-windows-x64.exe` again to get the maintenance choices:

- **Reinstall / upgrade** — overwrite-install with the new version.
- **Repair** — restore program files and Windows integration (Explorer right-click, PATH) without reopening the Setup wizard.
- **Uninstall** — launch the uninstaller.

On upgrade: program files update; your `%APPDATA%\prism-vesicle\` configuration and all project directories are preserved. On uninstall: the program, the PATH entry, and the Explorer integration are removed; user configuration and project data **are kept** (the uninstaller does not touch them). To remove everything, also delete `%APPDATA%\prism-vesicle\` by hand.

## npm

```bash
npm update -g prism-vesicle      # upgrade
npm uninstall -g prism-vesicle   # uninstall
```

The package ships a complete read-only V10 runtime baseline; an upgrade swaps in the new baseline. User configuration (`~/.config/prism-vesicle/` or `%APPDATA%\prism-vesicle\` on Windows) and projects are unaffected.

## Portable (Windows / Linux)

An upgrade means replacing the binary and **re-extracting the matching asset pack**:

- The binary and asset pack (`assets/`, `host-assets/`, `harness-manifest.json`) **must match in version**; replace both together.
- After extracting, keep the three pieces alongside the binary (see the layout in each portable start page).

User configuration and projects are unaffected.

## What survives, in principle

- **On one machine, all channels share the same user configuration directory.** Switching from the installer to npm or to a portable build needs no configuration changes.
- **Sessions belong to the project.** Each project directory has its own `.vesicle/sessions/`; a different project directory is a different set of sessions.

## Migration: an old root .env

Earlier versions might have placed a `.env` in the project root. This is no longer supported. Move its values into the user-level `.env` (beside `providers.yaml`) and delete the project-root `.env`. See [Configuration files](./configuration.md).
