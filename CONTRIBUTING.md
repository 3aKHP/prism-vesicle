# Contributing

[English](./CONTRIBUTING.md) | [简体中文](./CONTRIBUTING.zh-CN.md)

Prism Vesicle's internal development remains rapid, but public alpha release work follows the release branch and PR path in [`docs/dev/WORKFLOW.md`](./docs/dev/WORKFLOW.md).

Release contributors must follow the public [Code Signing Policy](./CODE_SIGNING_POLICY.md). External contributors retain authorship; the human maintainer `3aKHP` reviews repository changes. Windows signing is currently deferred, so the signing-approver role and per-request manual approval apply only when signing is taken up in the future.

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
bun run hooks:install
bun run doctor
bun run lint
bun run typecheck
bun test
bun run dev
```

`bun run hooks:install` selects the tracked `.githooks/` directory for this checkout. Its pre-push hook runs `bun run lint` (blocking the push when Biome reports a diagnostic) and then `git lfs pre-push` to upload any binary assets tracked via Git LFS. Binary assets (images, video, audio, fonts) are routed through Git LFS repo-wide by `.gitattributes`, so contributors need `git-lfs` installed — run `git lfs install` once after cloning so the smudge/clean filter and the push upload step work.

The TUI reads provider settings from:

- the user-level provider registry at `%APPDATA%\prism-vesicle\providers.yaml` on Windows or `$XDG_CONFIG_HOME/prism-vesicle/providers.yaml` / `~/.config/prism-vesicle/providers.yaml` elsewhere
- provider-specific environment variables from the `.env` file beside `providers.yaml`, with process environment variables used only as fallback
- an optional provider-level `userAgent`; Vesicle otherwise builds its branded value from the package version and active Bun runtime version
- optional Streamable HTTP MCP server settings from sibling `mcp.yaml`, or `VESICLE_MCP_FILE`; MCP header secrets still belong in the same user-level `.env`, not in `mcp.yaml`
- optional host tool approval settings from sibling `permissions.yaml`, or `VESICLE_PERMISSIONS_FILE`; this file contains no secrets, must not persist YOLO as its default, and may select one of the documented host-owned `shellInterpreter` profiles

Runtime assets form a separate read-only namespace: `<project>/assets/` overrides the user-global `assets/` beside `providers.yaml`, followed by one complete verified baseline. That baseline is either a project-pinned managed Harness Pack or the bundled V10 Pack shipped with the package or standalone release. The tracked `assets/` directory must remain the exact Harness manifest inventory; Vesicle-owned base prompts and the five generic Agent Profiles live in the restricted `host-assets/` layer. Use `vesicle assets status` when debugging resolution, follow [`docs/dev/ASSETS.md`](./docs/dev/ASSETS.md) when refreshing the baseline, and prefer sparse `assets materialize` overrides over full snapshots.

Old project-root `.env` files should be migrated to the user-level config directory and removed or renamed locally.

## Documentation Style

Markdown prose uses natural line wrapping. Keep each paragraph or list item on one source line and let the editor or renderer wrap it visually; do not insert line breaks to fit a fixed column width.

Use explicit line breaks only where Markdown structure or meaning requires them, including headings, blank lines between blocks, lists, tables, block quotes, and code blocks. Preserve intentional line structure inside examples, command output, poetry, or other content whose line boundaries are significant.

Keep root-document responsibilities distinct:

- `README.md` is the project entry point: installation, first run, concise feature overview, and documentation navigation.
- `STATUS.md` is the authoritative current implementation inventory, including tool surface, validators, verification, and known limits.
- `CHANGELOG.md` records notable released and unreleased changes.
- `CONTRIBUTING.md` owns contributor setup, repository boundaries, and documentation conventions.
- `docs/dev/STYLE.md` owns source-code structure and maintainability rules.
- `docs/dev/ARCHITECTURE.md` owns layering, dependency direction, and links to the authoritative runtime contracts.
- `docs/dev/WORKFLOW.md` owns development and publication workflow.

Prefer links to the authoritative document over duplicating detailed inventories in multiple root files.

### Documentation Languages

`README.md`, `CONTRIBUTING.md`, `CODE_SIGNING_POLICY.md`, and `PRIVACY.md` are canonical English root documents. Their Simplified Chinese counterparts use the `.zh-CN.md` suffix and should be updated in the same change whenever shared meaning changes.

The user manual scales by language directory: `docs/user/zh-CN/` is canonical and `docs/user/en/` mirrors the same relative filenames, navigation, commands, and shared meaning. `docs/user/README.md` is the language landing page.

Keep commands, paths, configuration keys, code, and product identifiers unchanged across languages. Translate the surrounding explanation for clarity rather than mirroring English sentence structure mechanically.

`STATUS.md`, `CHANGELOG.md`, `AGENTS.md`, `CLAUDE.md`, `LICENSE`, and `docs/dev/` remain single-language documents. Do not create translated copies without revisiting this policy.

## Pull Request Checklist

- Explain the behavior change and why it belongs in the current milestone.
- Include verification commands in the PR description.
- Update `README.md`, `STATUS.md`, `CHANGELOG.md`, `docs/dev/ARCHITECTURE.md`, or the owning domain contract when user-visible behavior, runtime behavior, or an architecture boundary changes. Update `docs/dev/STYLE.md` only when source-code conventions change.
- Keep generated `.vesicle/` sessions out of git.
- Keep new or edited Markdown prose naturally wrapped.

## Documentation Sweep

When tool names, provider behavior, session semantics, config variables, or artifact roots change, search the docs for stale terms before finishing:

```bash
rg "tool|session|provider|workspace|VESICLE_|M0|OpenTUI" README*.md STATUS.md CHANGELOG.md CONTRIBUTING*.md docs assets
```
