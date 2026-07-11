# Prism Vesicle Assets

This directory contains the Prism v9 assets needed by M0.

## Release Distribution

Standalone PE and ELF releases intentionally keep this directory external so
users can inspect, edit, and replace prompt/profile assets without rebuilding
the executable. Run `bun run build:assets` to create the release attachment
`dist/prism-vesicle-assets.zip`, then extract its top-level `assets/` directory
beside the selected binary.

The npm/Bun package also ships this directory as package data, so `npm install
@prism/vesicle` is independent of the standalone binary layout. Package-owned
assets are the default only when the current project has no `assets/` directory.
Run `bunx vesicle assets init` to copy an editable project-local override;
never edit the copy under `node_modules/`.

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
