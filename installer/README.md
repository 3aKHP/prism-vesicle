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

Use `INNO_SETUP_COMPILER` to point at a non-default `ISCC.exe`. Linux/WSL can
run `bun run build:installer:stage` to verify the staged payload; compilation
and install/uninstall smoke run on a native Windows CI runner.
