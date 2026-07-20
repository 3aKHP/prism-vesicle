# Windows portable

English | [简体中文](../../zh-CN/start/windows-portable.md)

For people who don't want to run the installer: no-install environments, USB runs, or users who want to verify every file. For the wizard and File Explorer integration, go back to the [Windows installer](./windows-installer.md).

## Download two files

From the official Release (names match the actual artifacts):

- The single-file executable `prism-vesicle-windows-x64-<version>.exe`
- The runtime asset pack `prism-vesicle-assets-<version>.zip`

The asset pack contains three things: `harness-manifest.json`, `assets\`, and `host-assets\`. They must match the binary version; replace both together when upgrading.

## Verify the download

This page is the "home" for checksum verification (the installer page only links to it). Compare against `SHA256SUMS.txt` in PowerShell:

```powershell
Get-FileHash .\prism-vesicle-windows-x64-<version>.exe -Algorithm SHA256
Get-FileHash .\prism-vesicle-assets-<version>.zip -Algorithm SHA256
```

Match the output to the corresponding line in `SHA256SUMS.txt`.

> The alpha artifacts are intentionally not Authenticode-signed (signing is deferred). A checksum confirms the file was not tampered with; it is not the same as a signature. See [Reference: Checksums and signing](../reference/checksums-and-signing.md).

## Layout

The executable locates its default resources **beside itself**, so the three pieces must sit alongside it in one directory:

```text
any folder\
├── prism-vesicle-windows-x64-<version>.exe   (or rename to vesicle.exe)
├── harness-manifest.json
├── assets\
└── host-assets\
```

For the short `vesicle` command, rename the exe to `vesicle.exe` (renaming does not affect runs; resources are still found by the real location).

## PATH (optional)

Without PATH you can still call it by full file name. To type `vesicle` from anywhere, add the folder above to your user PATH.

## Configure, check, start

Converges with the other channels:

```powershell
vesicle setup          # or hand-edit %APPDATA%\prism-vesicle\providers.yaml + .env
vesicle doctor
Set-Location C:\path\to\my-project
vesicle .
```

Configuration lives in `%APPDATA%\prism-vesicle\`, shared with the installer build — migrating from the installer needs no changes.

## Update

Replace the exe and re-extract the asset pack; user configuration and projects are unaffected. See [Reference: Update · uninstall · migrate](../reference/update-uninstall-migrate.md).

## Next step

→ [First conversation](../tutorials/first-conversation.md)
