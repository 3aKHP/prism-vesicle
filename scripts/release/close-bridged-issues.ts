/**
 * Cross-PR issue-closing bridge for the release flow.
 *
 * Invoked by `.github/workflows/close-issues.yml` after a `release/*` PR
 * merges into `main`. GitHub's native auto-close never fires for closing
 * keywords in PR bodies that target a non-default branch (`develop`), and it
 * does not revisit those declarations when the commits later reach `main`
 * through a release PR. This bridge closes that gap: it walks the commits the
 * release carried into `main`, recovers the constituent PR numbers
 * (native merges announce `Merge pull request #N from ...`; squash merges
 * carry a trailing `(#N)` in the subject), scans those PR bodies plus the
 * release PR body with GitHub-native inline keyword semantics, and closes
 * every still-open issue with a comment linking the originating and release
 * PRs.
 *
 * Commit messages are not scanned for keywords: GitHub natively closes
 * issues from commit-message keywords once the commit reaches the default
 * branch. Rebase-merged constituent PRs leave no PR reference in the commit
 * history and are not bridgeable; the supported constituent merge methods
 * are native merge and squash merge (see `docs/dev/WORKFLOW.md`).
 *
 * Usage (workflow): GITHUB_EVENT_PATH + GITHUB_TOKEN in the environment, then
 * `bun scripts/release/close-bridged-issues.ts`. The extraction helpers are
 * pure and unit-tested in `tests/unit/scripts/close-bridged-issues.test.ts`.
 */
import { readFileSync } from "node:fs";
import process from "node:process";

const CLOSING_KEYWORD_RE = /\b(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)\s*:?\s+#(\d+)\b/gi;
const MERGE_COMMIT_RE = /^Merge pull request #(\d+) from /gm;
const SQUASH_SUBJECT_RE = /\(#(\d+)\)\s*$/;

export type CommitLike = { message: string };

/** The compare endpoint nests the message: entries are `{ sha, commit: { message, ... } }`. */
export type CompareCommitLike = { commit?: { message?: string } };

/** Map compare-API entries to flat commit messages; missing payloads become empty strings. */
export function mapCompareCommitMessages(entries: CompareCommitLike[]): CommitLike[] {
  return entries.map((entry) => ({ message: entry.commit?.message ?? "" }));
}

/** Constituent PR numbers recoverable from a commit list (native-merge and squash forms). */
export function extractPrNumbersFromCommits(commits: CommitLike[]): number[] {
  const numbers = new Set<number>();
  for (const commit of commits) {
    for (const match of commit.message.matchAll(MERGE_COMMIT_RE)) {
      numbers.add(Number(match[1]));
    }
    const subject = commit.message.split("\n", 1)[0] ?? "";
    const squashed = subject.match(SQUASH_SUBJECT_RE);
    if (squashed) numbers.add(Number(squashed[1]));
  }
  return [...numbers].sort((a, b) => a - b);
}

/** Issue numbers declared with GitHub-native closing keywords anywhere in the text. */
export function extractClosingIssueNumbers(text: string | null | undefined): number[] {
  if (!text) return [];
  const numbers = new Set<number>();
  for (const match of text.matchAll(CLOSING_KEYWORD_RE)) {
    numbers.add(Number(match[1]));
  }
  return [...numbers].sort((a, b) => a - b);
}

export type PrBodyLike = { number: number; body: string | null | undefined };

/**
 * Map each declared issue to the PR that declared it. Constituent PRs are
 * passed before the release PR so a constituent declaration wins the origin
 * attribution; a release-body declaration is the fallback.
 */
export function collectIssueOrigins(prBodies: PrBodyLike[]): Map<number, number> {
  const origins = new Map<number, number>();
  for (const pr of prBodies) {
    for (const issue of extractClosingIssueNumbers(pr.body)) {
      if (!origins.has(issue)) origins.set(issue, pr.number);
    }
  }
  return origins;
}

type WorkflowEventPullRequest = {
  number: number;
  merged: boolean | null;
  body: string | null;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  merge_commit_sha: string | null;
};

type WorkflowEvent = {
  repository?: { full_name?: string };
  pull_request?: WorkflowEventPullRequest;
};

function requirePullRequest(event: WorkflowEvent): { pr: WorkflowEventPullRequest; repo: string } | undefined {
  const pr = event.pull_request;
  if (!pr || pr.merged !== true || !pr.merge_commit_sha) return undefined;
  if (!pr.head.ref.startsWith("release/")) return undefined;
  const repo = event.repository?.full_name;
  if (!repo) return undefined;
  return { pr, repo };
}

async function main(): Promise<number> {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const token = process.env.GITHUB_TOKEN;
  if (!eventPath || !token) {
    console.error("GITHUB_EVENT_PATH and GITHUB_TOKEN are required.");
    return 1;
  }
  const gated = requirePullRequest(JSON.parse(readFileSync(eventPath, "utf8")) as WorkflowEvent);
  if (!gated) {
    console.log("Not a merged release PR; nothing to do.");
    return 0;
  }
  const { pr, repo } = gated;

  const api = async <T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> => {
    const response = await fetch(`https://api.github.com/repos/${repo}/${path}`, {
      method: init?.method ?? "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(init?.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    });
    if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${path} -> ${response.status}`);
    return (await response.json()) as T;
  };

  // The merge commit's first parent is the pre-merge `main` tip: comparing it
  // against the release branch head bounds exactly what this release carried
  // in. This also works when the release PR itself was squash-merged, because
  // the release branch retains the full constituent history.
  const mergeCommit = await api<{ parents: { sha: string }[] }>(`commits/${pr.merge_commit_sha}`);
  const base = mergeCommit.parents[0]?.sha ?? pr.base.sha;
  const head = pr.head.sha;
  // The compare endpoint caps its commits array at 250 per page; paginate so
  // a large release range is never partially bridged. If the range is still
  // incomplete after the page cap, fail loudly rather than skip silently.
  const commits: CommitLike[] = [];
  let total = 0;
  for (let page = 1; page <= 10; page += 1) {
    const comparison = await api<{ commits?: CompareCommitLike[]; total_commits?: number }>(
      `compare/${base}...${head}?per_page=250&page=${page}`,
    );
    total = comparison.total_commits ?? 0;
    const batch = mapCompareCommitMessages(comparison.commits ?? []);
    commits.push(...batch);
    if (commits.length >= total || batch.length === 0) break;
  }
  if (commits.length < total) {
    console.error(`release range carries ${total} commits but only ${commits.length} were recovered; refusing to bridge partially.`);
    return 1;
  }
  console.log(`release range ${base.slice(0, 8)}...${head.slice(0, 8)} carries ${commits.length} commits`);

  const candidates = extractPrNumbersFromCommits(commits);
  console.log(`constituent PR candidates: ${candidates.map((n) => `#${n}`).join(", ") || "(none)"}`);

  const constituentBodies: PrBodyLike[] = [];
  for (const number of candidates) {
    const pull = await api<{ number: number; merged: boolean | null; body: string | null }>(`pulls/${number}`);
    if (pull.merged !== true) {
      console.log(`#${number} is not a merged PR; skipping.`);
      continue;
    }
    constituentBodies.push(pull);
  }

  const origins = collectIssueOrigins([...constituentBodies, { number: pr.number, body: pr.body }]);
  if (origins.size === 0) {
    console.log("no closing declarations found; nothing to close.");
    return 0;
  }

  const failures: number[] = [];
  for (const [issueNumber, originPr] of [...origins.entries()].sort((a, b) => a[0] - b[0])) {
    try {
      const issue = await api<{ state: string; pull_request?: unknown }>(`issues/${issueNumber}`);
      if (issue.pull_request) {
        console.log(`#${issueNumber} is a pull request; skipping.`);
        continue;
      }
      if (issue.state !== "open") {
        console.log(`#${issueNumber} is already ${issue.state}; skipping.`);
        continue;
      }
      await api(`issues/${issueNumber}/comments`, {
        method: "POST",
        body: { body: `Closed via #${originPr} as part of the release to \`main\` in #${pr.number}.` },
      });
      await api(`issues/${issueNumber}`, { method: "PATCH", body: { state: "closed" } });
      console.log(`Closed issue #${issueNumber} (declared by #${originPr}).`);
    } catch (err) {
      console.error(`Failed to close #${issueNumber}:`, err);
      failures.push(issueNumber);
    }
  }
  return failures.length > 0 ? 1 : 0;
}

if (import.meta.main) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
