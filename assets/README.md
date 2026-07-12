# Prism Vesicle Assets

This directory contains the Prism v9 assets needed by M0.

## Release Distribution

Standalone PE and ELF releases intentionally keep this directory external as the immutable release baseline. Run `bun run build:assets` to create `dist/prism-vesicle-assets.zip`, then extract its top-level `assets/` directory beside the selected binary. The executable may be launched from a separate project directory; it locates the release baseline beside `process.execPath` without changing the project working directory.

The npm/Bun package ships the same baseline as package data. Never edit package-owned files under `node_modules/` or the extracted release baseline. Vesicle resolves each logical path file by file in this order:

1. `<project>/assets/` sparse overrides.
2. User-global sparse overrides under `%APPDATA%\prism-vesicle\assets\` on Windows or `$XDG_CONFIG_HOME/prism-vesicle/assets/` / `~/.config/prism-vesicle/assets/` elsewhere.
3. Package-owned or standalone release defaults.

Directories merge across layers; a higher-layer file wins at the same logical path. Version 1 has no deletion tombstones. Use `vesicle assets status` to inspect layers, `vesicle assets materialize <assets/path> [--global]` to copy one editable file/directory, or `vesicle assets init [--global]` when a complete snapshot is intentionally required. Sparse overrides are preferred because untouched defaults continue to update with Vesicle releases.

## Source Paths

The source project is the public GitHub repository
[`3aKHP/Neural-Narratology`](https://github.com/3aKHP/Neural-Narratology).

- Engine prompts: `03_Modulation/Prism-Engine-Codex/shared/prompts/*.md`
- Specs: `03_Modulation/Prism-Engine-V9.x/specs/*.md`
- Templates: `03_Modulation/Prism-Engine-V9.x/templates/*.md`
- Protocol references: `02_Resonance/v9_State-Space/en-US/*.md`

## M0 Adaptation Notes

- Engine prompt headings and host identity lines were changed from Codex-specific wording to Vesicle wording.
- Host-specific file roots were normalized to Vesicle project roots such as `assets/specs`, `assets/templates`, `source_materials`, `workspace`, `test_runs`, `novels`, and `reports`. `source_materials` is writable for gathered or generated research; final artifacts stay in the other output roots.
- `new_task` references in copied specs were renamed to the Vesicle delegated subtask contract.
- The six engine prompts were otherwise preserved for M0. Full prompt redesign is intentionally deferred.

## Layout

- `prompts/shared/vesicle-base.md`: stable Vesicle host boundary contract
- `prompts/engines/*.md`: copied Prism v9 engine prompts with factual host adaptation
- `specs/*.md`: Prism v9 schemas
- `templates/*.md`: Prism v9 templates
- `protocol/v9-state-space/*.md`: Phase II protocol references
