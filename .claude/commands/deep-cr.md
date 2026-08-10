---
allowed-tools: Bash(git rev-parse:*), Bash(git status:*), Bash(git merge-base:*), Bash(git fetch:*), Bash(scripts/check/deep-cr-trigger.sh:*), Read, Workflow(deep-cr:*), ReportFindings, TodoWrite
description: Tier 2 deep multi-agent code review for high-risk cross-module diffs — 5 lens finders (sonnet), independent per-finding scorers (haiku), confidence >= 80 filter, synthesis into Blocking / Should-fix / Nits / Verified. Use only for the high-risk change classes in docs/dev/WORKFLOW.md; for ordinary PRs use the Tier 1 vesicle-cr-reviewer subagent. Read-only; it reports findings, never edits code.
disable-model-invocation: false
---

Run a Tier 2 **deep** code review on the current branch. This is read-only: render a review; do not edit code. Make a todo list first, then:

1. **Resolve scope.**
   - `branch` = current branch: `git rev-parse --abbrev-ref HEAD`.
   - `base` = the PR base if one is obvious from `git status` / PR context, else `develop`.
   - Ensure `base` is resolvable locally: if `git merge-base HEAD <base>` fails, run `git fetch origin <base>` and retry. If it still fails, stop and tell the user.

2. **Run the high-risk trigger gate** (default and recommended): `scripts/check/deep-cr-trigger.sh <base>`. It prints `{"trigger":bool,"reasons":[...]}` and never changes state.
   - If `trigger` is **false**: STOP. Tell the user this change does not meet the Tier 2 high-risk bar (category-match AND (cross-boundary OR size-floor OR release-branch), per the printed reasons), and that the Tier 1 `vesicle-cr-reviewer` subagent is the proportionate review. Offer to run Tier 2 anyway only if the user explicitly confirms — do not silently spend the heavy multi-agent budget on a low-risk change.
   - If `trigger` is **true**: continue.

3. **Invoke the `deep-cr` Workflow** via the Workflow tool with args `{ "branch": "<branch>", "base": "<base>" }`. It runs 5 sonnet lens finders (each runs `git diff` itself), one haiku scorer per candidate finding that re-verifies the cited doc and `file:line`, filters to confidence >= 80 with `docVerified && realIssue`, then a sonnet synthesis that classifies survivors. It **returns** `{ scope, stats, buckets: { blocking, shouldFix, nits, verified }, synthesisNotes, coverage }`.

4. **Render the result** by calling `ReportFindings` with the returned `buckets` flattened into one findings list, **most-severe first** in this order: `blocking`, then `shouldFix`, then `nits`, then `verified`. For each item pass:
   - `file`, `line` (from the finding);
   - `summary` = `[<Blocking|Should-fix|Nits|Verified>] <title> — <rationale>`;
   - `short_summary` = the bucket tag + title, trimmed to <= 60 characters;
   - `failure_scenario` = a concrete "inputs/state -> wrong outcome" derived from the rationale/evidence (for Verified items, a one-line note instead);
   - `category` = the lens domain slug (`tool-safety`, `provider`, `session`, `prompt-gates`, `structure`).
   Set `level` = `"medium"`. Do not invent or alter findings; if a bucket is empty, simply omit it.

5. **Print a short summary** for the user: per-bucket counts, the scope reviewed (`branch` vs `base`), the survivors/`candidatesRaw`/`scorerNoVote` stats, and the explicit "not verified" items from `coverage.notCheckedByLens`. Then recommend an action mirroring `docs/dev/WORKFLOW.md` "Handling CR Results":
   - **Blocking** → fix before merge.
   - **Should-fix** → fix unless there is a documented reason to defer.
   - **Nits** → optional; apply only if cheap and consistent with local style.
   - **Verified** → record in merge notes.
