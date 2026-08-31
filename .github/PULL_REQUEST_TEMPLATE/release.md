<!--
  Release PR to `main` (docs/dev/WORKFLOW.md § Release Lifecycle; Release grade
  of the Change Grading Workflow). GitHub offers no PR template chooser - open
  with:
    gh pr create --base main --title "release: prepare v<version>" \
      --template .github/PULL_REQUEST_TEMPLATE/release.md
  or add ?template=PULL_REQUEST_TEMPLATE/release.md to the compare URL.

  Issue closing needs no lines here: the close-issues bridge recovers the
  constituent PRs from the release commit range and reads their closing
  declarations. Repeating closing lines also works but is unnecessary.
-->

## Summary

- Channel and audience for this release (stable → npm `latest` / prerelease → `next`).
- What this release carries since the last tag.
- After merge: push the annotated tag `v<version>` on `main` → the pipeline publishes.

## Release checklist

- [ ] `package.json` version frozen to the target version
- [ ] `CHANGELOG.md` section added for this version
- [ ] `README.md` + `README.zh-CN.md` channel wording updated (dist-tag / install guidance)
- [ ] README static Status badge (both languages) reflects the new channel
- [ ] `STATUS.md` snapshot date / published version updated
- [ ] Advanced user-manual maturity stamps updated (`docs/user/{en,zh-CN}/advanced/`)
- [ ] Release notes disclose Windows signing status accurately (link the Code Signing Policy)

## Test Plan

- [ ] `bun run lint`
- [ ] `bun run typecheck`
- [ ] `bun test`
- [ ] `bun run doctor`
- [ ] `bun audit`
- [ ] `bun run pack:check` + `bun run pack:smoke`
- [ ] `bun run skills:docs:sync` (README/docs changed in this release)

### Recorded internal acceptance (per release runbook)

- [ ] `test:acceptance:provider` - record evidence
- [ ] Other acceptance lanes as applicable - record evidence or an explicit skip decision
- [ ] Windows acceptance per release grade

## Notes / Follow-ups

- ...
