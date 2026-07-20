# Claude Instructions for Prism Vesicle

`AGENTS.md` is the shared repo-local coordination authority for AI
collaborators. Read it first and follow its branch, commit, push, PR,
verification, secret-handling, and documentation-sweep rules.

During the rapid internal development phase, `develop` is the active trunk.
`docs/dev/WORKFLOW.md` defines when small and medium low-risk changes may be
committed directly to `develop` after explicit user approval, and when a
short-lived branch + PR is still required.

## Required Startup Reads

For non-trivial work, read these before editing:

- `AGENTS.md`: AI collaborator entry point and doc map.
- `STATUS.md`: current implementation state, known limits, tool surface, and
  verification commands.
- `docs/dev/STYLE.md`: architecture boundaries for providers, tools, prompts,
  sessions, validation, and TUI behavior.
- `docs/dev/WORKFLOW.md`: branching, hotfixes, PR body shape, independent CR,
  and documentation sweep.
- `CONTRIBUTING.md`: Conventional Commits, public repo boundary, provider config location, documentation style, and local development flow.

Also read:

- `README.md` when setup, user-facing commands, provider configuration, or
  capabilities are affected.
- `docs/user/en/README.md` and the affected English/Chinese chapter pair when beginner onboarding or user-manual behavior is affected.
- `CHANGELOG.md` before user-visible behavior, config, runtime, prompt, TUI,
  docs-status, or tool-surface changes.
- `assets/README.md` before editing copied Prism assets.
- `docs/examples/providers.yaml` before changing provider config behavior.
- `docs/examples/provider.env.example` before changing provider secret loading
  behavior.

For architecture, provider, TUI, session, or command-UX changes, first check whether the documented reference projects already solved a similar problem. Ignored local notes under `dev/docs/` may describe private reference locations; when present, start with `dev/docs/REFERENCE_PROJECTS.md` to find those local absolute paths and the current working/decision/archive routes. Use the notes, but treat archived plans as historical context and never copy local absolute paths or machine-private details into public docs.

## High-Risk Boundaries

- Prefer proven reference-project patterns over needless reinvention, while
  preserving Vesicle's Prism-host product boundary.
- Do not store provider secrets in `providers.yaml`.
- Do not depend on a project-root `.env`; provider secrets belong beside the
  user-level `providers.yaml`.
- Do not let provider adapters read/write files or run host tools.
- Do not hardcode Prism prompts into TypeScript source.
- Do not expose model-visible filesystem access outside `core/tools` path
  guards.
- Do not commit or push unless the user explicitly asks.

## Standard Verification

```bash
bun run lint
bun run typecheck
bun test
bun run doctor
```

## Test Value Discipline

Follow the full test-value rules in `AGENTS.md`. Do not add a test merely because code changed or because a task was completed. New test code must protect a user-visible behavior, security or durability boundary, external contract, or plausible uncovered regression, with an oracle independent of the implementation where practical.

- Features and fixes normally receive focused regression coverage for observable behavior; chores and mechanical changes do not receive new tests by default.
- Do not lock tests to local variable names, statement order, source snippets, or constants that only restate the implementation unless they are stable external or architecture contracts.
- Do not preserve brittle or redundant tests at the cost of large adaptation work. Reassess, narrow, merge, replace, or remove them when meaningful coverage is already present elsewhere.
- Report conditional coverage as skipped or unavailable rather than returning early and counting it as passing.
- Test counts are not a quality target, and verification does not imply that every change needs new test code.

Add or update focused tests only when the changed provider, gate, session, TUI, tool, validator, artifact, workflow, or release behavior creates a real coverage need. Report any skipped or unavailable verification explicitly.
