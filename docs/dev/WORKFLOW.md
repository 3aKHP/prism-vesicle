# Prism Vesicle Workflow

This document adapts the PRTS-MCP branch and independent review workflow to
Prism Vesicle's current M0 stage.

## Hard Rules

- Commit only after the user explicitly asks for a commit or PR.
- Push only after the user explicitly asks for a push.
- Keep work reviewable: one branch/PR should have one main intent.
- Update docs and changelog when behavior, config, tool surface, or runtime
  contracts change.

## Branch Model

### Bootstrap Exception

Before the first baseline commit, M0 scaffold work may remain on `main` because
there is no stable baseline to branch from yet.

### Normal Development

Once the baseline exists:

| Branch | Purpose |
|--------|---------|
| `main` | Stable baseline |
| `develop` | Integration branch for normal development |
| `feature/fix/docs/test/...` | Short-lived work branches |

Flow:

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

## Iteration Loop

### Normal Change

1. Align scope: state what changes, files likely touched, risks, and validation.
2. Branch from `develop` once `develop` exists.
3. Implement in small, reviewable commits when committing is requested.
4. Run local verification:

```powershell
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
6. Open PR when requested.
7. Run independent CR before merge.
8. Address Blocking and Should-fix findings.
9. Wait for human merge.

### Hotfix

Use this for regressions that block real use, such as:

- provider requests fail
- sessions lose history
- tools claim writes without writing
- path guards are unsafe
- TUI cannot exit or accept input

Flow:

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

```powershell
rg "write_file|tool_calls|session|VESICLE_|workspace|provider|OpenTUI" README.md STATUS.md CHANGELOG.md CONTRIBUTING.md docs assets
```

If the grep finds old behavior claims, update the docs in the same change.
