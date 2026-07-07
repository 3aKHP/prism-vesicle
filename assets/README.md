# Prism Vesicle Assets

This directory contains the Prism v9 assets needed by M0.

## Source Paths

The source project is the public GitHub repository
[`3aKHP/Neural-Narratology`](https://github.com/3aKHP/Neural-Narratology).

- Engine prompts: `03_Modulation/Prism-Engine-Codex/shared/prompts/*.md`
- Specs: `03_Modulation/Prism-Engine-V9.x/specs/*.md`
- Templates: `03_Modulation/Prism-Engine-V9.x/templates/*.md`
- Protocol references: `02_Resonance/v9_State-Space/en-US/*.md`

## M0 Adaptation Notes

- Engine prompt headings and host identity lines were changed from Codex-specific wording to Vesicle wording.
- Host-specific file roots were normalized to Vesicle project roots such as `assets/specs`, `assets/templates`, `workspace`, `test_runs`, `novels`, and `reports`.
- `new_task` references in copied specs were renamed to the Vesicle delegated subtask contract.
- The six engine prompts were otherwise preserved for M0. Full prompt redesign is intentionally deferred.

## Layout

- `prompts/shared/vesicle-base.md`: stable Vesicle host boundary contract
- `prompts/engines/*.md`: copied Prism v9 engine prompts with factual host adaptation
- `specs/*.md`: Prism v9 schemas
- `templates/*.md`: Prism v9 templates
- `protocol/v9-state-space/*.md`: Phase II protocol references
