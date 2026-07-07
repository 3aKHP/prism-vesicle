# Codex Instructions for Prism Vesicle

This file is repo-local coordination guidance for AI collaborators.

## Startup Reads

Before non-trivial code or prompt-runtime changes, read:

- `STATUS.md` for current project shape, tool surface, and known limits
- `docs/dev/STYLE.md` for architecture and runtime boundaries
- `docs/dev/WORKFLOW.md` for branch, PR, and independent CR workflow
- `CHANGELOG.md` before user-visible behavior changes

## Current Branch Model

Prism Vesicle is in M0 bootstrap. Until the first baseline commit exists, the
working tree may stay on `main` as an initialization exception.

After the baseline commit:

- `main` is the stable baseline.
- `develop` is the integration branch for normal development once created.
- Feature, refactor, docs, test, chore, and non-urgent fixes branch from
  `develop` and PR back to `develop`.
- Production-style hotfixes branch from `main` and PR back to `main`, then are
  forward-merged or cherry-picked to `develop`.

Do not push directly to long-lived branches. Do not commit or push unless the
user explicitly asks.

## Local Runtime

- Shell: PowerShell on Windows; prefer PowerShell 7 when available.
- Runtime: Bun.
- Standard verification:

```powershell
bun run typecheck
bun test
bun run doctor
```

## Project-Specific Guardrails

- Provider adapters must not execute filesystem operations.
- Model-visible tools must stay behind `core/tools` path guards.
- Prompt assets are runtime files under `assets/`; do not hardcode Prism prompts
  into TypeScript source.
- If model behavior claims a file was written, verify the corresponding
  `write_file` tool result or inspect the artifact on disk.
- User-visible behavior changes need `README.md`, `STATUS.md`, `CHANGELOG.md`,
  or `docs/dev/STYLE.md` updates as appropriate.

See `docs/dev/WORKFLOW.md` for the full iteration and independent CR process.
