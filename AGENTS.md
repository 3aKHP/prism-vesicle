# Codex Instructions for Prism Vesicle

This file is the repo-local entry point for AI collaborators. Treat it as the
navigation layer for the rest of the project docs, not as a replacement for
them.

## First Reads

Always read this file before working in the repository.

For any non-trivial code, prompt-runtime, TUI, provider, session, tool,
workflow, or documentation change, also read:

- `STATUS.md`: current project shape, implemented capabilities, tool surface,
  known limits, and standard verification.
- `docs/dev/STYLE.md`: architecture boundaries, provider adapter rules,
  tool-runtime security, prompt/session semantics, validation, and TUI rules.
- `docs/dev/WORKFLOW.md`: branch model, iteration loop, hotfix flow, PR shape,
  independent CR expectations, and documentation sweep.
- `CONTRIBUTING.md`: Conventional Commits, public repo boundary, local runtime, provider config location, documentation style, and PR checklist.
- `README.md`: project entry point, installation, first run, concise capability overview, and documentation navigation.
- `docs/user/en/README.md`: canonical ordered user-manual curriculum; pair user-facing chapter changes with the matching `docs/user/zh-CN/` file.

Read `CHANGELOG.md` before any user-visible behavior, config, runtime contract,
tool surface, TUI, prompt, or documentation-status change.

Read asset-specific docs when touching assets:

- `docs/dev/ASSETS.md`: bundled V10 inventory, host extension layer, lineage, and update rules.
- `docs/examples/providers.yaml`: canonical provider registry shape.
- `docs/examples/provider.env.example`: user-level provider secret file shape.

If a task touches architecture, provider behavior, TUI interaction, session semantics, or command UX, look for existing implementation patterns before inventing a new one. The ignored local `dev/docs/` area may contain private reference-project notes and local paths. When present, start with `dev/docs/REFERENCE_PROJECTS.md` to find the local reference project locations; use its working/decision/archive routes when available, but do not copy local absolute paths or private machine details into public docs. Archived local plans are historical context, never current authority.

## Documentation Map

Use the docs by responsibility:

| File | Authority |
|------|-----------|
| `README.md` | Project entry point, installation, first run, feature overview, and doc navigation |
| `docs/user/` | Ordered beginner-to-advanced user manuals; English canonical, Simplified Chinese mirrored |
| `STATUS.md` | Current implemented state, limits, tool surface, verification |
| `CHANGELOG.md` | User-visible and notable unreleased changes |
| `CONTRIBUTING.md` | Contributor workflow, repo boundary, provider setup, and documentation style |
| `docs/dev/STYLE.md` | Code architecture and runtime boundaries |
| `docs/dev/WORKFLOW.md` | Branching, PRs, hotfixes, independent CR |
| `AGENTS.md` / `CLAUDE.md` | AI collaborator startup and coordination |

When one of these files becomes stale because of your change, update it in the
same branch. Do not leave documentation drift for a later pass.

Follow the Markdown conventions in `CONTRIBUTING.md`: prose uses natural line wrapping rather than fixed-column hard wraps.

`README.md` and `CONTRIBUTING.md` are canonical English root documents. When shared meaning changes, update their `.zh-CN.md` counterparts in the same change. For user manuals, mirror every changed `docs/user/en/` chapter to the same relative path under `docs/user/zh-CN/`.

## Branch And PR Rules

`main` is the stable milestone baseline. `develop` is the active trunk during
rapid internal development.

- During the rapid internal development phase, `develop` is the active trunk.
  The Rapid Development Exception in `docs/dev/WORKFLOW.md` allows small and
  medium low-risk changes to be committed and pushed directly to `develop` when
  the user explicitly asks for commit/push work.
- Use a short-lived branch and PR for high-risk changes: provider protocols,
  streaming, model-visible tools, path guards, sessions, prompt contracts,
  validators, engine profiles, large refactors, release-readiness work, or
  anything needing Bot review / independent CR.
- Branch production-style hotfixes from `main`, PR them back to `main`, then
  forward-merge or cherry-pick to `develop`.
- Do not push directly to `main`.
- Do not force-push to `develop` unless the user explicitly asks.
- Do not commit, push, merge, tag, or open PRs unless the user explicitly asks.
- Use Conventional Commits when committing:
  `feat(scope): ...`, `fix(scope): ...`, `docs(scope): ...`,
  `test(scope): ...`, `refactor(scope): ...`, or `chore(scope): ...`.

Before finishing non-trivial PR work, expect an independent CR pass as
described in `docs/dev/WORKFLOW.md`. Address Blocking and Should-fix findings
before merge.

## Local Runtime

- Shell: zsh on WSL2 (Linux); Bun runtime. PowerShell also works on Windows.
- Runtime: Bun.
- Standard verification:

```bash
bun run typecheck
bun test
bun run doctor
```

The real-provider E2E test runs only when the selected provider's `apiKeyEnv`
is available through the user-level provider `.env` or process environment.

## Provider Configuration And Secrets

Provider/model profiles are user-level host state, not project runtime state.

- Provider registry path on Windows:
  `%APPDATA%\prism-vesicle\providers.yaml`
- Provider secret file on Windows:
  `%APPDATA%\prism-vesicle\.env`
- Other platforms:
  `$XDG_CONFIG_HOME/prism-vesicle/providers.yaml` and sibling `.env`, or
  `~/.config/prism-vesicle/providers.yaml` and sibling `.env`.

`providers.yaml` must contain provider ids, protocols, base URLs, model entries,
generation defaults, capability metadata, and `apiKeyEnv` names only. It must
not contain API keys. The sibling `.env` contains the provider-specific secret
values. Process environment variables are fallback only.

Do not reintroduce a project-root `.env` dependency. If an old root `.env`
appears during local work, treat it as legacy state to migrate or remove, not
as supported configuration.

## Architecture Guardrails

These are non-negotiable boundaries; see `docs/dev/STYLE.md` for detail.

- Prefer adapting proven patterns from the documented reference projects over
  rebuilding familiar agent/runtime behavior from scratch. Record borrowed
  behavior in public docs/tests when it affects Vesicle's runtime contract, but
  keep private reference paths confined to ignored local notes.
- Provider adapters convert normalized Vesicle requests to provider wire
  format and back. They must not read/write project files, mutate sessions,
  know Prism phases, or execute host tools.
- Model-visible filesystem tools must stay behind `core/tools` path guards.
- Filesystem tool paths are project-relative only; absolute paths and `..` escapes are rejected. The opt-in `shell_exec` process tool is the explicit exception: it has host-user authority, is controlled by Tool Permission Runtime, and must never be described as path-guarded or rewind-safe.
- Write tools are limited to approved roots: `source_materials/`, `workspace/`,
  `test_runs/`, `novels/`, and `reports/`. `source_materials/` holds imported,
  researched, or model-generated source material; deployed artifacts belong in
  the other four roots.
- Prompt assets are runtime files under `assets/`; do not hardcode Prism
  prompts into TypeScript source.
- Host-specific prompts, coding-agent identities, and tool assumptions must
  not leak into Prism engine prompts except as explicit negative examples.
- `request_confirmation` is a workflow gate declared by engine profile
  `stopGates`, not a generic permission prompt.
- Permission modes change approval friction but never widen tool capabilities or disable path guards, MCP/Agent scope, timeout, environment filtering, output limits, or process cleanup. YOLO cannot be persisted as a default; `--dangerously-skip-permissions` is process-scoped.
- If model behavior claims a file was written, verify the corresponding
  `write_file` result or inspect the artifact on disk.
- Validators are advisory product signals. They should surface findings without
  aborting ordinary turns unless a feature explicitly changes that contract.

## TUI And Session Rules

- One interactive TUI run should keep one active session until the user starts
  or resumes another session.
- Session JSONL records are append-only and should preserve user, assistant,
  tool, provider/model, validation, and gate information needed for replay.
- Provider/model switching and artifact workbench commands are host actions;
  they should not call the provider unless the command explicitly starts a
  revision prompt.
- Keep the TUI operational and readable at 80 columns. Gate and picker panels
  own the bottom area while active.

## Verification And Documentation Sweep

Choose verification proportional to risk. For most changes, run:

```bash
bun run typecheck
bun test
bun run doctor
```

For provider, gate, TUI, or artifact behavior, add or update focused tests.
When practical, also run a real TUI or provider smoke.

Before finishing behavior/config/docs changes, run a targeted stale-term pass.
Examples:

```bash
rg "VESICLE_|providers.yaml|apiKeyEnv|session|write_file|tool_calls|OpenTUI" README*.md STATUS.md CHANGELOG.md CONTRIBUTING*.md docs assets
rg "provider|engine|artifact|gate|validator|workspace" README*.md STATUS.md CHANGELOG.md CONTRIBUTING*.md docs assets
```

Mention any verification gap explicitly in the final handoff.

## Public Repo Boundary

Never commit secrets or local runtime state:

- user-level `.env`
- project-root `.env`
- `.vesicle/`
- generated workspaces or model output beyond tracked `.gitkeep` stubs
- private provider URLs, API keys, tokens, or local prompt experiments

Keep generated artifact roots and session state out of git unless a task
explicitly asks for a tracked fixture.
