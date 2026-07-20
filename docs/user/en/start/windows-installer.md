# Windows installer start

English | [简体中文](../../zh-CN/start/windows-installer.md)

For creators using a terminal program for the first time. Follow along for about 15 minutes and you will: install Vesicle → connect a model service in the wizard → open it in your own project folder.

There are only two prerequisites: Windows 10/11 (x64), and an API key for a model service. If you don't have a key yet, get one from your provider before coming back.

## Download the installer

Download `PrismVesicleSetup-<version>-windows-x64.exe` from the GitHub Releases page.

> Download only from the official Release page. To verify the file or learn about signing status, see [Reference: Checksums and signing](../reference/checksums-and-signing.md).

## Run the installer

Three facts, one line each:

- It installs into your user directory (`%LOCALAPPDATA%\Programs\Prism Vesicle`) and **does not need administrator privileges**.
- Upgrade or reinstall leaves your configuration and projects untouched (configuration lives in `%APPDATA%\prism-vesicle\`, separate from the program directory).
- Running the same installer again offers maintenance choices: Reinstall / Repair / Uninstall. See [Reference: Update · uninstall · migrate](../reference/update-uninstall-migrate.md) for details.

Keep **Configure and launch Prism Vesicle** checked on the installer's last page; it opens the configuration wizard automatically. The Start Menu group **Prism Vesicle** has three entries: **Configure Prism Vesicle** (reopen the wizard), **Prism Vesicle Doctor** (check the environment), and **Uninstall Prism Vesicle** (uninstall).

## Finish the Setup wizard

The wizard uses three keys throughout: arrow keys to move, Enter to continue, Esc to go back one screen (Ctrl+Q to quit). Walk through it in order:

1. **Welcome** — choose Begin guided setup.
2. **Base URL** — enter your provider's OpenAI-compatible Base URL (for example `https://api.example.com/v1`). If you omit `/v1`, the wizard adds it automatically.
3. **API key** — paste the key (the field is masked, never shown in clear text). The wizard then contacts the provider to request the model list **without saving the key yet**.
4. **Choose models** — press Space to toggle the models you want; press `A` to add an exact model id manually (this also works if discovery failed). Select at least one.
5. **Default model** — pick one of your selected models as the default.
6. **Tavily (optional)** — web research tools. Choose **Skip for now** as a beginner; you can return any time.
7. **MCP (optional)** — external tool servers. Also choose **Skip for now** as a beginner.
8. **Permission preset** — one of three: **Recommended** (default; reads and ordinary changes proceed, shell stays off) / **More cautious** (changes ask first) / **Ask every time** (every step asks). Keep Recommended.
9. **First-launch folder (optional)** — optionally pick a folder for the wizard to open once; you can also skip and later start with `vesicle .` in any project directory. Vesicle never remembers a single "global project."
10. **Review and save** — this screen shows a summary and **no secrets**. If existing configuration files are present, timestamped backups are made before saving.
11. **Complete** — if you chose a folder in step 9, you can "Launch this folder once"; otherwise exit the wizard.

> The wizard's model discovery supports only OpenAI-compatible `/v1/models`. If you use an Anthropic or Gemini native endpoint, discovery finds nothing — skip the wizard and edit `providers.yaml` manually as shown in [npm](./npm.md) or [Windows portable](./windows-portable.md), and look up the exact shape in [Configuration](../reference/configuration.md).

## Check: Doctor

Open **Prism Vesicle Doctor** from the Start Menu. In a healthy run you want to confirm two lines — `API key: available` and `Missing: none`:

```text
Prism Vesicle Doctor
Provider: example-openai
Base URL: https://api.example.com/v1
Model: gpt-4o-mini
API key: available
…
Missing: none
```

If either is wrong, reopen **Configure Prism Vesicle** from the Start Menu and fix it; for more cases see [Reference: Troubleshooting](../reference/troubleshooting.md).

## Open your first project

Two ways, two lines each:

- In File Explorer, right-click your project folder → **Open in Prism Vesicle** (on Windows 11 it may be under "Show more options"; right-clicking the folder background works too).
- Or in PowerShell: `Set-Location` to the project folder, then `vesicle .`:

```powershell
Set-Location C:\path\to\my-project
vesicle .
```

Remember one thing: **the folder you start Vesicle from is where your sessions and artifacts are stored.** Press Ctrl+Q to exit.

## Something went wrong?

- Installer blocked by security software — allow it temporarily, or switch to the [Windows portable](./windows-portable.md) build; always download only from the official Release.
- The wizard got closed — reopen **Configure Prism Vesicle** from the Start Menu; what you entered is not lost.
- Doctor reports `Missing: …` — reopen **Configure Prism Vesicle** and follow the prompt.
- Typing `vesicle` in a terminal says the command is not found — **open a new terminal**. The installer added `vesicle` to your user PATH, but terminals already open do not refresh it.

## Next step

→ [First conversation](../tutorials/first-conversation.md)
