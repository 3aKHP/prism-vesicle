# Contributing

Prism Vesicle's internal development remains rapid, but public alpha release
work follows the release branch and PR path in `docs/dev/WORKFLOW.md`.

## Branch And Commit Style

For the full branch and independent CR workflow, see
[`docs/dev/WORKFLOW.md`](./docs/dev/WORKFLOW.md).

During ordinary rapid internal development, `develop` is the active trunk. Small and
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

Use `docs/examples/provider.env.example` for the user-level secret file shape.

## Local Development

```bash
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
- an optional provider-level `userAgent`; Vesicle otherwise builds its branded
  value from the package version and active Bun runtime version
- optional Streamable HTTP MCP server settings from sibling `mcp.yaml`, or
  `VESICLE_MCP_FILE`; MCP header secrets still belong in the same user-level
  `.env`, not in `mcp.yaml`
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

```bash
rg "tool|session|provider|workspace|VESICLE_|M0|OpenTUI" README.md STATUS.md CHANGELOG.md CONTRIBUTING.md docs assets
```
