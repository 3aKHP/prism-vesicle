# Contributing

Prism Vesicle is still in M0, so the main goal is to keep the runtime small,
testable, and honest about what it can execute.

## Branch And Commit Style

For the full branch and independent CR workflow, see
[`docs/dev/WORKFLOW.md`](./docs/dev/WORKFLOW.md).

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

- `.env`
- `.vesicle/`
- local prompt experiments
- generated test workspaces
- provider API keys, tokens, or private base URLs

Use `.env.example` for configuration shape.

## Local Development

```powershell
bun install
bun run doctor
bun run typecheck
bun test
bun run dev
```

The TUI reads provider settings from:

- `VESICLE_PROVIDER`
- `VESICLE_BASE_URL`
- `VESICLE_MODEL`
- `VESICLE_API_KEY`

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
