# Contributing

[English](./CONTRIBUTING.md) | [简体中文](./CONTRIBUTING.zh-CN.md)

Prism Vesicle's internal development remains rapid, but public alpha release work follows the release branch and PR path in [`docs/dev/WORKFLOW.md`](./docs/dev/WORKFLOW.md).

## Branch And Commit Style

During ordinary rapid internal development, `develop` is the active trunk. Small and medium low-risk changes may go directly to `develop` when commit/push work is explicitly requested. Use a short-lived branch and PR for high-risk provider, tool, session, prompt, validator, engine-profile, large-refactor, release, or review-heavy work. Do not push directly to `main`.

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

Use [`docs/examples/provider.env.example`](./docs/examples/provider.env.example) for the user-level secret file shape.

## Local Development

```bash
bun install
bun run doctor
bun run typecheck
bun test
bun run dev
```

The TUI reads provider settings from:

- the user-level provider registry at `%APPDATA%\prism-vesicle\providers.yaml` on Windows or `$XDG_CONFIG_HOME/prism-vesicle/providers.yaml` / `~/.config/prism-vesicle/providers.yaml` elsewhere
- provider-specific environment variables from the `.env` file beside `providers.yaml`, with process environment variables used only as fallback
- an optional provider-level `userAgent`; Vesicle otherwise builds its branded value from the package version and active Bun runtime version
- optional Streamable HTTP MCP server settings from sibling `mcp.yaml`, or `VESICLE_MCP_FILE`; MCP header secrets still belong in the same user-level `.env`, not in `mcp.yaml`

Runtime assets form a separate read-only overlay namespace: `<project>/assets/` overrides the user-global `assets/` beside `providers.yaml`, which overrides the defaults shipped with the package or standalone release. Use `vesicle assets status` when debugging resolution and prefer sparse `assets materialize` overrides over full snapshots.

Old project-root `.env` files should be migrated to the user-level config directory and removed or renamed locally.

## Documentation Style

Markdown prose uses natural line wrapping. Keep each paragraph or list item on one source line and let the editor or renderer wrap it visually; do not insert line breaks to fit a fixed column width.

Use explicit line breaks only where Markdown structure or meaning requires them, including headings, blank lines between blocks, lists, tables, block quotes, and code blocks. Preserve intentional line structure inside examples, command output, poetry, or other content whose line boundaries are significant.

Keep root-document responsibilities distinct:

- `README.md` is the project entry point: installation, first run, concise feature overview, and documentation navigation.
- `STATUS.md` is the authoritative current implementation inventory, including tool surface, validators, verification, and known limits.
- `CHANGELOG.md` records notable released and unreleased changes.
- `CONTRIBUTING.md` owns contributor setup, repository boundaries, and documentation conventions.
- `docs/dev/STYLE.md` and `docs/dev/WORKFLOW.md` own architecture and development workflow respectively.

Prefer links to the authoritative document over duplicating detailed inventories in multiple root files.

### Documentation Languages

`README.md` and `CONTRIBUTING.md` are canonical English root documents. Their Simplified Chinese counterparts use the `.zh-CN.md` suffix and should be updated in the same change whenever shared meaning changes.

The user manual scales by language directory: `docs/user/en/` is canonical and `docs/user/zh-CN/` mirrors the same relative filenames, chapter numbers, navigation, commands, and shared meaning. `docs/user/README.md` is the language landing page.

Keep commands, paths, configuration keys, code, and product identifiers unchanged across languages. Translate the surrounding explanation for clarity rather than mirroring English sentence structure mechanically.

`STATUS.md`, `CHANGELOG.md`, `AGENTS.md`, `CLAUDE.md`, `LICENSE`, and `docs/dev/` remain single-language documents. Do not create translated copies without revisiting this policy.

## Pull Request Checklist

- Explain the behavior change and why it belongs in the current milestone.
- Include verification commands in the PR description.
- Update `README.md`, `STATUS.md`, `CHANGELOG.md`, or `docs/dev/STYLE.md` when the user-visible behavior, runtime contract, or architecture boundary changes.
- Keep generated `.vesicle/` sessions out of git.
- Keep new or edited Markdown prose naturally wrapped.

## Documentation Sweep

When tool names, provider behavior, session semantics, config variables, or artifact roots change, search the docs for stale terms before finishing:

```bash
rg "tool|session|provider|workspace|VESICLE_|M0|OpenTUI" README*.md STATUS.md CHANGELOG.md CONTRIBUTING*.md docs assets
```
