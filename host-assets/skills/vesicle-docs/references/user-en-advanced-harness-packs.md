<!-- Generated from docs/user/en/advanced/harness-packs.md — do not edit. -->

# Harness Packs: manage the creative baseline

English | [简体中文](../../zh-CN/advanced/harness-packs.md)

> **Status as of `1.0.0-rc.1`:** 🟢 Offline verify/install/use/status/rollback is implemented. Online discovery, download, extraction, and automatic update are not.

A Harness Pack is a complete manifest-verified Prism creative baseline. Engine profiles, prompts, validators, Agent profiles, Skills, and the Adapter Binding must move together as one version. A normal first installation already includes the V10 baseline, so **you do not need to install a Pack**. Use this page only after receiving a complete, extracted Pack directory from a trusted source.

## Inspect the current baseline

Run this in the target project directory:

```bash
vesicle assets status
```

Success includes `Active baseline: bundled ...` or `Active baseline: managed <id>@<version>`, plus the manifest SHA-256. `bundled` means the installation's built-in baseline. `managed` means this project pins another installed Pack.

## Install and select a Pack

Run all four steps in the **project that should use the Pack**. Replace the example with the extracted Pack directory:

```bash
vesicle assets verify /path/to/extracted-pack
vesicle assets install /path/to/extracted-pack
vesicle assets use <pack-id>@<version>
vesicle assets status
```

1. `verify` validates without installing. Success reports `compatible=true` and an asset count; hash, manifest, compatibility, or ABI errors fail closed.
2. `install` copies an immutable snapshot into the user Store. Success reports `Installed Harness <id>@<version>`.
3. `use` writes `.vesicle/assets.lock.json` for the **current project**. Success reports `Activated managed Harness ... for this project.`
4. Run `status` again and confirm `Active baseline: managed` matches the chosen id/version.

Then run `vesicle doctor` and `vesicle prompt shape --engine etl`, and start a **new session**. Startup and resume reverify the locked identity. If an old session recorded another Harness identity, provider continuation is blocked instead of silently using a different baseline.

## Roll back to bundled V10

If you selected the wrong version, the Pack is missing, or you want the default again:

```bash
vesicle assets rollback
vesicle assets status
```

Success first reports `Rolled back <id>@<version>; bundled V10 baseline is active.`, then `Active baseline: bundled ...`. Rollback removes only this project's selection lock. It does not delete installed Packs from the user Store or modify artifacts.

## Customize only one prompt or Agent

If you only need one project-specific file, do not copy the whole Harness. Confirm the baseline with `status`, then materialize a sparse override:

```bash
vesicle assets materialize assets/prompts/engines/etl.md
```

This copies the effective version into the corresponding project `assets/` path and refuses an existing target. `--global` writes a user override that affects all projects and is usually inappropriate for a beginner. `vesicle assets init [--global]` remains the compatibility command for copying the full editable tree, but a full copy is more likely to drift after upgrades.

A materialized prompt is the **compiled effective layer**. Its Host Adapter Binding maps Prism operations to Vesicle tools, gates, and quality policy. Do not remove binding sections you do not understand. After editing, run:

```bash
vesicle prompt shape --engine etl
vesicle doctor
```

Confirm the source and environment, then test in a new session. To remove a sparse override, back up your changes and manually remove the file you materialized. `assets rollback` only changes managed-Pack selection; it does not remove local overrides.

## Common failures

- `compatible=false`: do not install. Read each compatibility error and obtain a complete Pack matched to this Vesicle version.
- `Harness reference must use <pack-id>@<version>`: copy the exact id and version from successful `verify` / `install` output.
- Startup reports Harness identity drift: restore the Pack recorded by the session or start a new session. Do not edit session JSONL to bypass identity checks.
- Materialize refuses overwrite: a custom target already exists. Compare and back it up manually; the tool does not overwrite it for you.
- The Pack is still an archive: extract it into a separate directory with system tools. Vesicle does not currently extract or download Packs.

## Checklist

- [ ] `assets status` tells you whether the current baseline is bundled or managed.
- [ ] You know a complete Pack follows verify → install → use → status.
- [ ] You know `rollback` changes project selection but does not delete the Store or local overrides.
- [ ] You know to prefer `materialize` for one-file customization and verify it in a new session.
