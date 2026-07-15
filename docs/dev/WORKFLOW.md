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

For public-release paths, this exception is retired:
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

## CI/CD State Machine

CI/CD has two entry points and one shared implementation. A version-tag push is the publication authorization; normal releases do not require an Actions-page dispatch or GitHub Environment approval. If SignPath Authenticode is enabled, its required per-request human signing approval remains a separate external trust gate.

| Entry point | Trigger | Source | Retention | External side effects |
|-------------|---------|--------|-----------|-----------------------|
| `CI` | PR into `develop`/`main`, push to `develop`, or manual dispatch | Event commit | 7 days | None |
| `Publish release` | Push an annotated `v*` tag | Tag commit on the `main` history | 30 days | GitHub Release and npm publish |
| `Reusable release build` | Called by CI or Publish | Caller-supplied exact ref | Caller-selected | None |

The reusable workflow is the single owner of the release gates:

- Bun 1.3.14 for project installation, tests, packaging, and standalone builds
- Node 24 runtime lines for GitHub-maintained JavaScript Actions, `oven-sh/setup-bun`, and the GitHub Release Action; npm Trusted Publishing also installs Node 24 explicitly
- frozen Bun install
- package-version validation
- typecheck, deterministic tests, dependency audit, npm allowlist check, and clean npm consumer smoke
- Linux ELF build and empty-project release-shape smoke
- Windows PE build, focused Windows runtime tests, and empty-project release-shape smoke
- pinned Inno Setup build, silent install, upgrade, runtime, and uninstall smoke
- versioned Linux, Windows, assets-ZIP, and installer artifacts

The empty-project smoke runs `debug markdown-runtime`, `assets status`, asset materialization, and `prompt shape --engine etl` from outside the release directory. The Windows installer smoke additionally verifies the native `vesicle.exe` command, Explorer integration, legacy-launcher cleanup, exact PATH ownership, and preservation of user/project data.

### Release Lifecycle

1. Freeze `package.json`, `CHANGELOG.md`, release notes, and supported user-facing scope on `release/v<version>-<topic>`. Release notes must link the public Code signing policy and state accurately whether that version's Windows artifacts are signed.
2. Run the standard local verification, then open a PR to `main`. PR CI executes the same reusable release build and provides short-lived Linux, Windows, assets-ZIP, and installer artifacts for review and human testing.
3. Complete independent CR, the opt-in real-provider acceptance test, and any required small-group Windows acceptance. Merge the reviewed release PR to `main`.
4. Update the local `main` with a fast-forward-only pull and confirm that `HEAD` is the accepted release commit.
5. Create one annotated `v<package.json version>` tag on that commit and push that exact tag. This `git push` is the explicit publication authorization.
6. The tag workflow rejects a lightweight tag, a tag/version mismatch, or a tag whose commit is outside the remote `main` history. If validation succeeds, it reruns every shared gate, uploads the versioned artifacts, creates the GitHub Release and checksums, then publishes npm through Trusted Publishing.
7. Verify the public GitHub assets, checksums, npm version/dist-tag, bin launcher, provenance attestation, and a clean installed invocation before announcing the release.

For `1.0.0-alpha.2`, the complete normal publication command sequence after the release PR is merged is:

```bash
git switch main
git pull --ff-only origin main
test "$(git branch --show-current)" = "main"
test "$(bun -e 'console.log((await Bun.file("package.json").json()).version)')" = "1.0.0-alpha.2"
git tag -a v1.0.0-alpha.2 -m "Prism Vesicle v1.0.0-alpha.2"
git push origin v1.0.0-alpha.2
```

The push is sufficient to start publication. Git cannot inspect Actions or registry state, so use the read-only CLI checks below when you want to observe and verify the result without opening a browser:

```bash
gh run list --workflow release.yml --limit 5
gh run watch <run-id> --exit-status
gh release view v1.0.0-alpha.2 --json tagName,isPrerelease,assets
npm view prism-vesicle@1.0.0-alpha.2 version dist-tags bin --json
```

Do not tag `develop` or a release branch. After publication, forward-sync the released `main` commit back to `develop` through the normal reviewed branch flow when the histories differ.

### Code Signing Readiness

The public [Code Signing Policy](../../CODE_SIGNING_POLICY.md) defines the intended Windows signing scope, maintainer roles, user verification, and incident handling. The [Privacy Policy](../../PRIVACY.md) documents the local and external-service data behavior required for public distribution. The SignPath Foundation application was submitted on 2026-07-15, but approval and Authenticode CI integration remain pending.

`1.0.0-alpha.2` is an explicit unsigned exception for the small, informed alpha test group. Its generated GitHub Release notes must prepend a bilingual warning that identifies both Windows artifacts as unsigned, links the code-signing policy, points to `SHA256SUMS.txt`, and tells users not to disable Windows security globally. While this exception is active, release metadata validation pins the only publishable package version to exactly `1.0.0-alpha.2`; every later version requires a reviewed workflow change that either integrates signing or records another explicit alpha decision. This exception ends no later than `1.0.0-beta.1`; a release candidate must reuse a signing path already exercised during beta rather than introducing signing for the first time.

After SignPath acceptance, tag push remains the maintainer's command-line publication authorization, but every production signing request must also be manually inspected and approved in SignPath. The signing implementation must sign and verify the portable PE before installer staging, enable and verify the generated signed uninstaller, then sign and verify the final installer. A failed or unapproved signing request must block publication of the affected Windows artifact; it must never silently fall back to an unsigned file.

### First-Time Bootstrap

The tag-triggered workflow must exist on `main` before the release tag is pushed. The first release-readiness PR installs this control plane and validates it through PR CI; merging that PR does not publish anything. Do not push `v1.0.0-alpha.2` until this workflow and the release content are both present on the accepted `main` commit.

### Required GitHub Settings

Configure these settings before the first public tag:

- protect `main`; require PR review and the reusable CI jobs, and disallow direct/force pushes
- protect `v*` tags with a repository ruleset and limit creation/deletion to release maintainers
- keep one exact repository-owner admin as an `always` bypass actor on both rulesets. This is the audited emergency path for unavailable reviewers, stale required-check names, or release recovery; do not extend the bypass to Write or Maintain roles
- keep the `npm` Environment name required by the npm Trusted Publisher, restrict it to protected version tags, and do not add required reviewers or wait timers to the normal release path
- retain default workflow permissions as read-only; grant `contents: write` and `id-token: write` only to the individual publishing jobs
- consider requiring full commit-SHA pins for third-party actions once the release pipeline shape is stable

Repository rules and Environment protection are live GitHub state, not YAML. Audit them before every public milestone instead of assuming the documentation configured them.

### Failure And Retry Rules

- A failed PR CI run has no public side effects. Fix the release branch and let the updated PR commit run again.
- Do not create the release tag until PR CI and human acceptance are complete.
- A pushed release tag is immutable publication intent. Do not delete or move it merely to retrigger CI.
- If a transient failure happens after the tag push, use the CLI to find and rerun the existing workflow: `gh run list --workflow release.yml`, then `gh run rerun <run-id> --failed`. This exceptional recovery needs `gh` because Git cannot truthfully push the same immutable tag twice. The npm job skips an exact version that is already present, and the GitHub Release job updates the release for the same tag.
- Never move, delete, or recreate a tag after any registry has accepted that version. Repair forward with a new prerelease version when published bytes or metadata are wrong.

The real-provider gate acceptance test is intentionally opt-in because it is model-output dependent: run `BUN_E2E_REAL_PROVIDER=1 bun test tests/e2e-gate.test.ts` from the trusted dogfood environment and record the result before creating a public tag. It validates a real provider without making ordinary CI depend on provider credentials, model determinism, or unapproved API spend.

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
rg "write_file|tool_calls|session|VESICLE_|workspace|provider|OpenTUI" README*.md STATUS.md CHANGELOG.md CONTRIBUTING*.md docs assets
```

If the grep finds old behavior claims, update the docs in the same change.
