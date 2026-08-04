<!-- Generated from docs/dev/AUDIT_DRIFT.md — do not edit. -->

# Audit Database Drift

Dependency audit gates compare the local lockfile against a live vulnerability database that only grows. A newly published advisory can therefore turn CI red on a commit that changed nothing — the same lockfile was green the day before. This document is the standing response plan for that situation, codified from the convention established by PR #48 and PR #92 (`chore(deps): patch brace-expansion audit finding`).

## Gates Covered

Three audit gates can go red from drift:

| Gate | Location | Scope |
|------|----------|-------|
| `bun audit` | `.github/workflows/release-build.yml` (`checks` job, shared by PR/develop CI and the release pipeline) | Full dependency tree of the checkout |
| Consumer `npm audit --omit=dev --audit-level=low` | `scripts/smoke-npm-package.ts` (`bun run pack:smoke`) | Production dependencies as installed by an npm consumer |
| Manual release verification | [`WORKFLOW.md`](./WORKFLOW.md) verification table | `bun audit` before a release tag |

The vulnerability database is monotonic: advisories are added, essentially never removed. Rerunning a failed job (`gh run rerun`) cannot recover a drift red — the same database answer comes back. The retry rules in [`WORKFLOW.md`](./WORKFLOW.md) do not apply to audit failures.

## Recognizing Drift

An audit red is **drift** when all of these hold:

- the failing run's diff does not touch `bun.lock` or `package.json`;
- the same commit (or the same lockfile) previously passed the same gate;
- the named advisory (GHSA/CVE) was published after the lockfile was last written.

An audit red on a PR that **does** change dependencies is not drift — it is the PR author's responsibility and is handled inside that PR, not through this plan.

When the `bun audit` step fails in the shared CI workflow, a follow-up step annotates the run and the step summary with a pointer to this document. Treat that annotation as a prompt to run the recognition check above, not as proof of drift.

## Standard Response: Fix Forward

Follow the PR #48 / #92 convention. The audit gate stays blocking; the response is a fast, dedicated repair.

1. Triage the advisory: severity, whether the package is a direct or transitive dependency, the dependency chain that pulls it in, and whether Vesicle actually executes the affected code (shipped production dependency vs. build-only or dev-only chain). Record a real-risk assessment from this triage.
2. Open a dedicated `chore(deps): patch <package> audit finding` PR. Never bundle the fix into a feature PR, and never widen an in-flight feature PR to absorb it.
3. For a transitive finding, pin the patched release through `package.json` `overrides` and regenerate `bun.lock`. For a direct finding, bump the declared version normally.
4. The commit message must name the GHSA/CVE id, the dependency chain, the reachability/real-risk assessment, and the verification list (see PR #92 for the shape).
5. Verify: `bun audit` green, plus `bun run lint`, `bun run typecheck`, `bun test`, `bun run doctor`, `bun run pack:check`, and `bun run pack:smoke` (which includes the consumer `npm audit` gate). An exact override bump adds no tests, per the test value discipline in `AGENTS.md`.
6. Land the patch PR on `develop` first; in-flight PRs rebase or re-run afterwards. One drift fix unblocks the whole pipeline.

## Exceptional Waiver Path

Use this only when no patched release exists, or the patched release is breaking and cannot be adopted quickly.

1. Complete the triage above. A waiver for a reachable, high/critical, shipped production path is expected to be rare and short-lived.
2. Add the finding to the `bun audit` invocation as `--ignore=<CVE>` (Bun ignores by CVE id; repeat the flag for multiple ids).
3. Record the waiver in the commit message and in `CHANGELOG.md`: CVE id, justification from the triage, owner, and an explicit expiry/revisit date.
4. Before the revisit date, re-triage: adopt a patch if one has appeared, renew with fresh justification, or drop the waiver. Expired waivers are never silently carried forward.
5. The consumer `npm audit` gate has no ignore mechanism. Waiving a finding there requires changing `scripts/smoke-npm-package.ts` to parse `npm audit --json` and filter waived ids; that code change must be proposed and justified in the same PR as the waiver, and it stays limited to ids with a recorded, unexpired waiver.

## Release Rule

Do not create a release tag while any audit gate is red or any waiver is past its revisit date. This extends the release rules in [`WORKFLOW.md`](./WORKFLOW.md); a drift fix during release preparation follows the same dedicated-PR flow, then the release branch picks it up.

## Considered Alternatives

Two CI relaxations were considered and rejected for now: making the PR-CI audit advisory (`continue-on-error`), and gating the audit only on lockfile changes in the PR diff. Both trade a visible, blocking signal for silent accumulation of unpatched advisories, and the historical fix-forward turnaround has been fast enough that the blocking gate has not materially delayed unrelated work. Revisit this decision if drift frequency or fix latency grows.
