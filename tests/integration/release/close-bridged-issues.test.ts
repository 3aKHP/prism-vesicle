import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../../../scripts/release/close-bridged-issues";

describe("release issue-closing bridge", () => {
  const originalFetch = globalThis.fetch;
  const originalEventPath = process.env.GITHUB_EVENT_PATH;
  const originalToken = process.env.GITHUB_TOKEN;
  let root: string;
  let responses: Map<string, Response>;
  let writes: { method: string; path: string; body: unknown }[];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "vesicle-close-issues-"));
    process.env.GITHUB_EVENT_PATH = join(root, "event.json");
    process.env.GITHUB_TOKEN = "test-token";
    await writeFile(process.env.GITHUB_EVENT_PATH, JSON.stringify({
      repository: { full_name: "owner/repo" },
      pull_request: {
        number: 314, merged: true, body: "Closes #281",
        head: { ref: "release/v1.1.0", sha: "head" },
        base: { ref: "main", sha: "base" },
        merge_commit_sha: "merge",
      },
    }));
    responses = new Map(Object.entries({
      "commits/merge": { parents: [{ sha: "base" }] },
      "compare/base...head?per_page=250&page=1": {
        total_commits: 3,
        commits: [
          { commit: { message: "feat(deps): adopt OpenTUI fork (#273)" } },
          { commit: { message: "Merge pull request #274 from owner/feature" } },
          { commit: { message: "fix: another candidate (#275)" } },
        ],
      },
      "issues/273": { number: 273, state: "closed", body: "Closes #999" },
      "issues/274": { number: 274, pull_request: {} },
      "pulls/274": { number: 274, merged: true, body: "Closes #281. Fixes #282. Resolves #283." },
      "issues/275": { number: 275, pull_request: {} },
      "pulls/275": { number: 275, merged: false, body: "Closes #999" },
      "issues/281": { state: "open" },
      "issues/282": { state: "closed" },
      "issues/283": { state: "open", pull_request: {} },
    }).map(([path, body]) => [path, Response.json(body)]));
    writes = [];
    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input));
      expect(url.origin).toBe("https://api.github.com");
      expect(url.pathname.startsWith("/repos/owner/repo/")).toBe(true);
      const path = url.pathname.slice("/repos/owner/repo/".length) + url.search;
      const method = init?.method ?? "GET";
      if (method !== "GET") {
        writes.push({ method, path, body: JSON.parse(String(init?.body)) });
        return Response.json({});
      }
      return responses.get(path)?.clone() ?? Response.json({ message: "Not Found" }, { status: 404 });
    }) as typeof fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    if (originalEventPath === undefined) delete process.env.GITHUB_EVENT_PATH;
    else process.env.GITHUB_EVENT_PATH = originalEventPath;
    if (originalToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = originalToken;
    await rm(root, { recursive: true, force: true });
  });

  test("skips issue-number suffixes and closes only open issues declared by merged PRs", async () => {
    // In v1.1.0, the ordinary commit ending in (#273) preceded PR #274.
    // /pulls/273 returns 404: this must not prevent the later PR's closure.
    expect(await main()).toBe(0);
    expect(writes).toEqual([
      {
        method: "POST", path: "issues/281/comments",
        body: { body: "Closed via #274 as part of the release to `main` in #314." },
      },
      { method: "PATCH", path: "issues/281", body: { state: "closed" } },
    ]);
  });

  test.each([
    ["issues/273", 403],
    ["issues/273", 404],
    ["issues/273", 500],
    ["pulls/274", 404],
  ] as const)("fails before closing issues when GET %s returns %i", async (path, status) => {
    responses.set(path, Response.json({ message: "API failure" }, { status }));
    await expect(main()).rejects.toThrow(`GET ${path} -> ${status}`);
    expect(writes).toEqual([]);
  });
});
