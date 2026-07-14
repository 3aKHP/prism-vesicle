# Windows installer

The first public-dogfood installer uses Inno Setup 6. It installs the complete
standalone Windows runtime per-user and launches Vesicle's own guided Setup;
the Inno script never receives provider, Tavily, or MCP secrets.

On Windows with Inno Setup 6 installed:

```powershell
bun run build:installer
```

The command builds `prism-vesicle.exe`, stages the exact runtime payload under
`dist/installer-stage/`, and writes
`dist/PrismVesicleSetup-<version>-windows-x64.exe`.

The installed `vesicle.cmd` alias forwards to the standalone executable, so a
new terminal can run `vesicle .` from any project. Per-user Explorer directory
and directory-background actions provide the same path launch without a shell.
Setup never persists a global project directory.

Use `INNO_SETUP_COMPILER` to point at a non-default `ISCC.exe`. Linux/WSL can
run `bun run build:installer:stage` to verify the staged payload; compilation
and install/uninstall smoke run on a native Windows CI runner.

The Simplified Chinese Inno messages are vendored from Inno Setup 7.0.2 so
builds do not depend on optional compiler language files. The file declares
compatibility with Inno Setup 6.5.0 and later. See
`languages/LICENSE-Inno-Setup.txt` for its upstream source and license.
