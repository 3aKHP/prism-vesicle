# npm install

English | [简体中文](../../zh-CN/start/npm.md)

For developers already using Bun: install once globally, then start with `vesicle .` in any project directory. This page does not explain terminal or API-key basics.

## Prerequisite

Bun ≥ 1.3.14 (per the `engines` field in `package.json`).

## Install

```bash
npm install -g prism-vesicle
vesicle prompt shape --engine etl
```

The package ships a complete read-only V10 runtime baseline (`assets/`, `host-assets/`, `harness-manifest.json`); no separate Harness install is needed. The second command prints the composed ETL engine structure to confirm the install works.

If you prefer not to install globally, you can also `npm install prism-vesicle` inside a project and use `bunx vesicle …`; global install is the recommended path and directly supports the standard `cd project && vesicle .` workflow.

## Configure

Two options, either one:

- `vesicle setup` — run the terminal wizard (the **same** wizard as the Windows installer): paste an API key masked, auto-discover OpenAI-compatible models.
- Or edit the user-level configuration by hand: `~/.config/prism-vesicle/providers.yaml` plus a sibling `.env` (on Windows, `%APPDATA%\prism-vesicle\`). Start from [`docs/examples/providers.yaml`](../../../examples/providers.yaml) and [`provider.env.example`](../../../examples/provider.env.example).

Keys go only in `.env`, never in `providers.yaml`.

## Check and start

```bash
vesicle doctor
cd /path/to/my-project
vesicle .
```

The directory you call from is the project root; sessions and artifacts live inside that project.

## Update / uninstall

```bash
npm update -g prism-vesicle
npm uninstall -g prism-vesicle
```

Your configuration lives in `~/.config/prism-vesicle/` (or `%APPDATA%\prism-vesicle\` on Windows); uninstalling the package does not affect configuration or projects. See [Reference: Update · uninstall · migrate](../reference/update-uninstall-migrate.md) for more.

## Next step

→ [First conversation](../tutorials/first-conversation.md)
