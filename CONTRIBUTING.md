# Contributing

Prism Vesicle is in rapid internal development, so the main goal is to keep the
runtime small, testable, and honest about what it can execute while preserving
enough process to recover from risky changes.

## Branch And Commit Style

For the full branch and independent CR workflow, see
[`docs/dev/WORKFLOW.md`](./docs/dev/WORKFLOW.md).

During rapid internal development, `develop` is the active trunk. Small and
medium low-risk changes may go directly to `develop` when commit/push work is
explicitly requested. Use a short-lived branch and PR for high-risk provider,
tool, session, prompt, validator, engine-profile, large-refactor, release, or
review-heavy work. Do not push directly to `main`.

Use Conventional Commits:

```text
type(scope): summary
```

Common types:

- `feat`: user-visible capability
- `fix`: behavior correction
- `docs`: documentation-only change
- `refactor`: internal reshaping without behavior change
- `test`: test coverage
- `chore`: repository maintenance

## Public Repo Boundary

Do not commit local runtime state or secrets:

- user-level `.env`
- `.vesicle/`
- local prompt experiments
- generated test workspaces
- provider API keys, tokens, or private base URLs

Use `.env.example` for the user-level secret file shape.

## Local Development

```powershell
bun install
bun run doctor
bun run typecheck
bun test
bun run dev
```

The TUI reads provider settings from:

- the user-level provider registry at `%APPDATA%\prism-vesicle\providers.yaml`
  on Windows or `$XDG_CONFIG_HOME/prism-vesicle/providers.yaml` /
  `~/.config/prism-vesicle/providers.yaml` elsewhere
- provider-specific environment variables from the `.env` file beside
  `providers.yaml`, with process environment variables used only as fallback
- old project-root `.env` files should be migrated to the user-level config
  directory and removed or renamed locally

## Pull Request Checklist

- Explain the behavior change and why it belongs in the current milestone.
- Include verification commands in the PR description.
- Update `README.md`, `STATUS.md`, `CHANGELOG.md`, or `docs/dev/STYLE.md` when
  the user-visible behavior, runtime contract, or architecture boundary changes.
- Keep generated `.vesicle/` sessions out of git.

## Documentation Sweep

When tool names, provider behavior, session semantics, config variables, or
artifact roots change, grep the docs for stale terms before finishing:

```powershell
rg "tool|session|provider|workspace|VESICLE_|M0|OpenTUI" README.md STATUS.md CHANGELOG.md CONTRIBUTING.md docs assets
```
