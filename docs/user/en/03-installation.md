# 03 — Install Prism Vesicle

[← Previous: Model providers](./02-model-providers.md) | [Manual index](./README.md) | [简体中文](../zh-CN/03-installation.md) | [Next: Guided provider setup →](./04-first-provider.md)

## What You Will Accomplish

You will install Prism Vesicle for your Windows account and open its guided Setup. This path does not require Bun, PowerShell commands, or configuration-file editing.

**Estimated time:** 5 minutes

**Prerequisites:** Chapters 00–02, Windows 10/11 x64, and an internet connection for the download

## Download the Installer

Open the official [Prism Vesicle releases page](https://github.com/3aKHP/prism-vesicle/releases) and open the matching prerelease. Download the file named like:

```text
PrismVesicleSetup-1.0.0-alpha.2-windows-x64.exe
```

Do not download an installer forwarded through chat, email, or an unrelated mirror. The release also provides `SHA256SUMS.txt` for users who need to verify the download checksum.

The Windows executable and installer for `1.0.0-alpha.2` are intentionally not Authenticode-signed while the SignPath Foundation application is pending. Download only from the official GitHub Release, verify `SHA256SUMS.txt`, and do not disable Windows security features globally. Historical Windows artifacts are also unsigned unless the individual Release notes explicitly say otherwise. For a Release described as signed, follow the [Code Signing Policy](../../../CODE_SIGNING_POLICY.md) to inspect the Windows signature and signer. A checksum alone is not an Authenticode signature.

## Run the Installer

Open the downloaded installer. Prism Vesicle installs only for your Windows account under `%LOCALAPPDATA%\Programs\Prism Vesicle`, so it does not normally request administrator access.

Keep the default installation folder unless you have a specific reason to change it. Continue through the installation pages, then leave **Configure and launch Prism Vesicle** selected on the final page.

The installer adds these Start Menu entries:

- **Configure Prism Vesicle** reopens the guided Setup at any time.
- **Prism Vesicle Doctor** checks an existing configuration.
- **Uninstall Prism Vesicle** removes program files while preserving user configuration and projects.

It also registers the native `vesicle.exe` command and an Explorer **Open in Prism Vesicle** action for directories. Open a new terminal after installation before testing the command.

If Prism Vesicle is already installed, opening the installer first presents **Reinstall / upgrade**, **Repair**, and **Uninstall**. Reinstall replaces the installed runtime and may reopen Guided Setup; Repair restores program files, PATH, shortcuts, and Explorer integration without reopening Guided Setup; Uninstall starts the existing uninstaller. All three preserve user configuration and project folders under the normal lifecycle.

The [Privacy Policy](../../../PRIVACY.md) explains what remains on the computer after uninstall, how to remove that local data, and when configured providers or optional services receive data.

## Open Guided Setup

Select **Finish**. A terminal window opens with the title `Prism Vesicle Setup` and a highlighted **Begin guided setup** choice. You do not need to type a command.

Use the arrow keys to move, Space to select checkboxes, Enter to continue, and either the visible **Back** choice or Escape to return to the previous page. Secret fields display dots instead of the API key text. Setup switches to a compact clipped layout instead of overlapping rows when the terminal window is small.

## If Installation Fails

- Confirm that the installer came from the official GitHub prerelease.
- If Windows reports that the download is incomplete, download it again.
- If security software quarantines the file, record the exact product name, installer version, and warning before reporting it. Do not disable security software globally.
- If Setup was closed, open **Configure Prism Vesicle** from the Start Menu.

## Advanced Alternatives

The GitHub prerelease retains the portable Windows executable and runtime-assets ZIP. npm and source-checkout installation remain available for developers and advanced users; see the root [README](../../../README.md). They are not the beginner path.

## Completion Check

You are ready when the `Prism Vesicle Setup` welcome screen is visible.

[Next: Configure Your First Provider →](./04-first-provider.md)
