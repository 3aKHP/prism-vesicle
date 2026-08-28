# Windows installer

The first public-dogfood installer uses Inno Setup 6. It installs the complete standalone Windows runtime per-user and launches Vesicle's own guided Setup; the Inno script never receives provider, Tavily, or MCP secrets.

On Windows with Inno Setup 6 installed:

```powershell
bun run build:installer
```

The command builds `prism-vesicle.exe`, stages the exact runtime payload under `dist/installer-stage/`, and writes `dist/PrismVesicleSetup-<version>-windows-x64.exe`.

The installer renames the staged standalone binary to the native `vesicle.exe` command, so a new terminal can run `vesicle .` from any project without a batch wrapper. Per-user Explorer directory and directory-background actions provide the same path launch without a shell. Upgrades remove the old binary, wrapper, and Start Menu project launcher. Rerunning the installer shows Reinstall / Repair / Uninstall maintenance choices; Repair restores installed files and Windows integration without reopening Guided Setup. Setup never persists a global project directory.

The installer is compiled with the deterministic inputs under `brand/windows/`: the canonical multi-size `prism-vesicle.ico` supplies Setup, the generated uninstaller, and the installed executable's system-entry icon; `prism-vesicle-wizard.png` supplies the Inno Setup wizard image. These files are compiler inputs and are not copied into the installed runtime directory. Build the branded PE and installer on native Windows; a WSL cross-build is deliberately named `prism-vesicle-cross-windows-x64.exe` and is not a release artifact because Bun cannot write Windows PE resources while cross-compiling.

Use `INNO_SETUP_COMPILER` to point at a non-default `ISCC.exe`. Installer staging now requires the canonical branded `prism-vesicle.exe`, so the full stage/build and install/uninstall smoke run on a native Windows CI runner; Linux/WSL verifies the stage shape through the contract tests instead of substituting the explicitly non-release cross-build PE.

The Simplified Chinese Inno messages are vendored from Inno Setup 7.0.2 so builds do not depend on optional compiler language files. The file declares compatibility with Inno Setup 6.5.0 and later. See `languages/LICENSE-Inno-Setup.txt` for its upstream source and license.
