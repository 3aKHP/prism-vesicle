# Prism Vesicle Workflow

This document adapts the PRTS-MCP branch and independent review workflow to
Prism Vesicle's current rapid internal development stage.

## Hard Rules

- Commit only after the user explicitly asks for a commit or PR.
- Push only after the user explicitly asks for a push.
- Keep work reviewable: one branch/PR should have one main intent.
- Update docs and changelog when behavior, config, tool surface, or runtime
  contracts change.
- Never commit secrets, generated session state, or local runtime artifacts.

## Branch Model

### Long-Lived Branches

| Branch | Purpose |
|--------|---------|
| `main` | Stable milestone snapshot and future public-release baseline |
| `develop` | Rapid internal development trunk |
| `feature/fix/docs/test/...` | Short-lived work branches |

Default full GitFlow remains available:

```text
feat/refactor/docs/test/chore/* -> develop
fix/* hotfix                       -> main -> develop
release/*                         -> main + develop
```

Branch naming:

```text
<type>/v<target-version>-<topic>
```

Examples:

- `feat/v0.1.0-provider-responses`
- `fix/v0.1.0-tool-path-guard`
- `docs/v0.1.0-runtime-contract`

## Rapid Development Exception

Prism Vesicle is currently in a fast internal development phase with no public
release pressure and no external user dependency on `main`. During this phase,
`develop` is the active trunk.

Small and medium changes may be committed and pushed directly to `develop` when
the user explicitly asks for commit/push work and the change is easy to review
from the commit itself. Examples:

- documentation-only updates
- prompt or asset copy edits that do not change runtime contracts
- focused TUI interaction fixes
- tests and local verification improvements
- small bug fixes with low blast radius
- narrow refactors that preserve behavior and boundaries

Use a short-lived branch and PR for higher-risk work:

- provider protocol, streaming, or adapter changes
- model-visible tool contracts, path guards, or write semantics
- session schema, replay, resume, or migration behavior
- prompt contracts, stop gates, validator contracts, or engine profiles
- large refactors or cross-module changes
- changes intended for `main`, a tag, or release readiness
- changes where Bot review or independent CR is useful

`main` does not need to be updated on every iteration in this phase. Update
`main` only for milestone snapshots, release-readiness checkpoints, or explicit
user requests.

The exception does not relax these rules:

- no direct push to `main`
- no force-push to `develop` unless the user explicitly requests it
- no secrets or runtime state in git
- no provider/filesystem/prompt boundary violations
- Conventional Commits still apply
- verification must match the risk of the change

For the `1.0.0-alpha.1` public-release path, this exception is retired:
release-readiness changes use a release branch and PR, require independent CR,
and must not be tagged from an unreviewed dogfood worktree. Keep `develop` as
the integration trunk for subsequent internal iteration.

## Iteration Loop

### Normal Change

1. Align scope: state what changes, files likely touched, risks, and validation.
2. Decide whether the Rapid Development Exception allows direct `develop`
   work. Otherwise branch from `develop`.
3. Implement in small, reviewable commits when committing is requested.
4. Run local verification:

```bash
bun run typecheck
bun test
bun run doctor
```

5. Update docs:
   - `README.md` for user-facing usage
   - `STATUS.md` for current project shape or limits
   - `CHANGELOG.md` for user-visible changes
   - `docs/dev/STYLE.md` for architecture rules
   - `docs/dev/WORKFLOW.md` for process changes
6. Push directly to `develop` only when allowed by the Rapid Development
   Exception and explicitly requested by the user; otherwise open a PR when
   requested.
7. Run independent CR before merge for non-trivial PRs.
8. Address Blocking and Should-fix findings.
9. Wait for human merge when using PR flow.

### Verification Matrix

Use the smallest verification set that proves the change:

| Change type | Minimum verification |
|-------------|----------------------|
| docs only | targeted docs grep and, when cheap, `bun run typecheck` |
| small code | `bun run typecheck` plus focused tests |
| provider/session/tool/gate/TUI runtime | `bun run typecheck`, relevant tests, `bun run doctor` |
| release or `main` snapshot | `bun run typecheck`, `bun test`, `bun run doctor`, and real TUI/provider smoke when practical |

## CI And Release Verification

The GitHub Actions CI workflow runs for pull requests into `develop`/`main`
and pushes to `develop`. It runs deterministic typecheck/test gates, builds the
Linux ELF and native Windows PE, then smoke-tests each binary beside extracted
`assets/` with `debug markdown-runtime` and `prompt shape --engine etl`.

`Release verification` is manual and does not publish. Supply the current
`package.json` semver as its candidate label; after the same gates it uploads
labelled PE, ELF, and assets-ZIP workflow artifacts. It is the required
preflight before the protected tag workflow runs. A tag must exactly match
`v<package.json version>`; the publish workflow rebuilds the PE, ELF, assets
ZIP, and checksums, creates the GitHub prerelease, then runs npm trusted
publishing with provenance. Configure GitHub tag protection and the npm trusted
publisher before creating the tag.

The real-provider gate acceptance test is intentionally opt-in because it is
model-output dependent: run `BUN_E2E_REAL_PROVIDER=1 bun test
tests/e2e-gate.test.ts` from the trusted dogfood environment and record the
result before creating a public tag. It validates a real provider without
making ordinary CI depend on provider credentials or model determinism.

### Hotfix

Use this for regressions that block real use, such as:

- provider requests fail
- sessions lose history
- tools claim writes without writing
- path guards are unsafe
- TUI cannot exit or accept input

Use the hotfix path only when `main` or a tagged milestone must be repaired.
During rapid internal development, most urgent fixes can go through `develop`.

Full hotfix flow:

1. Branch from `main`.
2. Patch the smallest concrete failing path.
3. Add a regression test when practical.
4. Update `CHANGELOG.md` and relevant docs.
5. Verify locally.
6. PR to `main`, then forward-merge/cherry-pick to `develop`.

## Independent CR

Every non-trivial PR should be reviewed by an independent agent or reviewer that
did not participate in the implementation conversation.

### Reviewer Prompt Template

```text
You are an independent code reviewer for Prism Vesicle.

Review branch: <branch>
Base branch: <base>
PR / diff summary: <summary>

Be critical. Do not assume the implementation intent is correct just because
the author says so.

Focus areas:
- Tool safety: path guards, allowed roots, write semantics, tool result handling
- Provider protocol: OpenAI-compatible message shape, tool_calls loop, error cases
- Session semantics: history reuse, JSONL persistence, replay/debug usefulness
- Prompt honesty: model cannot claim writes unless tools succeeded
- TUI behavior: input, exit, copy, layout stability
- Tests: regression coverage for the real failure mode
- Docs: README/STATUS/CHANGELOG/STYLE consistency

Return:
- Blocking
- Should-fix
- Nits
- Verified claims
```

### Handling CR Results

- Blocking: fix before merge.
- Should-fix: fix unless there is a documented reason to defer.
- Nits: apply when cheap and consistent with local style.
- Verified claims: keep them in the PR body or merge notes when useful.

## PR Body Shape

```markdown
## Summary

- ...

## Test Plan

- [ ] `bun run typecheck`
- [ ] `bun test`
- [ ] `bun run doctor`

## Notes / Follow-ups

- ...
```

## Documentation Sweep

Before finishing behavior changes, run a targeted stale-term pass. Examples:

```bash
rg "write_file|tool_calls|session|VESICLE_|workspace|provider|OpenTUI" README.md STATUS.md CHANGELOG.md CONTRIBUTING.md docs assets
```

If the grep finds old behavior claims, update the docs in the same change.
