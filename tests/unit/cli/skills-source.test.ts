import { describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installFromGitHub, installFromLocalPath, isRemoteSource, parseGitHubUrl, updateSkill } from "../../../src/cli/skills-source";
import { listSkillVersions, readProvenance, rollbackSkill, skillStoreDirectory } from "../../../src/skills";

const gitSupported = await (async (): Promise<boolean> => {
  try {
    return Bun.spawnSync(["git", "--version"]).exitCode === 0;
  } catch {
    return false;
  }
})();

const tarSupported = await (async (): Promise<boolean> => {
  try {
    return Bun.spawnSync(["tar", "--version"]).exitCode === 0;
  } catch {
    return false;
  }
})();

async function withEnv<T>(work: (env: NodeJS.ProcessEnv, scratch: string) => Promise<T>): Promise<T> {
  const scratch = await mkdtemp(join(tmpdir(), "vesicle-skill-source-"));
  const env = { ...process.env, VESICLE_CONFIG_DIR: join(scratch, "config") };
  try {
    return await work(env, scratch);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function makeSource(parent: string, name: string, body: string): Promise<string> {
  const root = join(parent, name);
  await mkdir(root, { recursive: true });
  await mkdir(join(root, "references"), { recursive: true });
  await writeFile(join(root, "SKILL.md"), `---
name: ${name}
description: "demo: ${name}"
---
${body}
`, "utf8");
  await writeFile(join(root, "references", "glossary.md"), "gloss", "utf8");
  return root;
}

function git(repo: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", "-C", repo, ...args]);
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr?.toString() ?? result.exitCode}`);
  }
}

async function makeGitRepo(parent: string, name: string, body: string): Promise<string> {
  const repo = await makeSource(parent, name, body);
  git(repo, "init", "--quiet");
  git(repo, "-c", "user.email=t@t", "-c", "user.name=test", "add", "-A");
  git(repo, "-c", "user.email=t@t", "-c", "user.name=test", "commit", "--quiet", "-m", "init");
  return repo;
}

async function writeSkillAt(directory: string, name: string, body: string): Promise<void> {
  await mkdir(join(directory, "references"), { recursive: true });
  await writeFile(join(directory, "SKILL.md"), `---
name: ${name}
description: "demo: ${name}"
---
${body}
`, "utf8");
  await writeFile(join(directory, "references", "glossary.md"), "gloss", "utf8");
}

async function makeTarball(parent: string, topLevel: string): Promise<Buffer> {
  const archive = join(parent, `${topLevel}.tar.gz`);
  const result = Bun.spawnSync(["tar", "-czf", archive, "-C", parent, topLevel]);
  if (result.exitCode !== 0) throw new Error(`tar create failed: ${result.stderr?.toString()}`);
  return await readFile(archive);
}

describe("local directory acquisition", () => {
  test("installs a root-skill directory into the store", async () => {
    await withEnv(async (env, scratch) => {
      const src = await makeSource(scratch, "rootskill", "root body");
      const [provenance] = await installFromLocalPath(src, { env });
      expect(provenance.name).toBe("rootskill");
      expect(provenance.sourceKind).toBe("local-directory");
      expect(provenance.skillRoot).toBe(".");
      const stored = await readFile(join(skillStoreDirectory(env), "rootskill", provenance.version, "SKILL.md"), "utf8");
      expect(stored).toContain("root body");
    });
  });

  test("auto-selects a single nested skill", async () => {
    await withEnv(async (env, scratch) => {
      await makeSource(join(scratch, "pkg"), "only", "nested body");
      const [provenance] = await installFromLocalPath(scratch, { env });
      expect(provenance.name).toBe("only");
      expect(provenance.skillRoot).toBe("pkg/only");
    });
  });

  test("installs every skill in a collection with --all", async () => {
    await withEnv(async (env, scratch) => {
      await makeSource(join(scratch, "skills"), "alpha", "a");
      await makeSource(join(scratch, "skills"), "beta", "b");
      const results = await installFromLocalPath(scratch, { all: true, env });
      expect(results.map((r) => r.name).sort()).toEqual(["alpha", "beta"]);
    });
  });

  test("refuses to guess when multiple skills are ambiguous", async () => {
    await withEnv(async (env, scratch) => {
      await makeSource(scratch, "a", "x");
      await makeSource(scratch, "b", "y");
      await expect(installFromLocalPath(scratch, { env })).rejects.toThrow(/Multiple Skills found/);
    });
  });

  test("--path selects one skill from a collection", async () => {
    await withEnv(async (env, scratch) => {
      await makeSource(join(scratch, "skills"), "alpha", "a");
      await makeSource(join(scratch, "skills"), "beta", "b");
      const results = await installFromLocalPath(scratch, { path: "skills/beta", env });
      expect(results.map((r) => r.name)).toEqual(["beta"]);
    });
  });

  test("rejects a source with no SKILL.md", async () => {
    await withEnv(async (env, scratch) => {
      await mkdir(join(scratch, "empty"), { recursive: true });
      await expect(installFromLocalPath(scratch, { env })).rejects.toThrow(/No SKILL\.md/);
    });
  });
});

describe("local git acquisition", () => {
  test("installs a clean HEAD snapshot without VCS metadata", async () => {
    if (!gitSupported) return;
    await withEnv(async (env, scratch) => {
      const repo = await makeGitRepo(scratch, "gitskill", "clean body");
      const [provenance] = await installFromLocalPath(repo, { env });
      expect(provenance.sourceKind).toBe("local-git");
      expect(provenance.resolvedCommit).toMatch(/^[0-9a-f]{40}$/);
      expect(provenance.dirtySource).toBeUndefined();
      const versionDir = join(skillStoreDirectory(env), "gitskill", provenance.version);
      const stored = await readFile(join(versionDir, "SKILL.md"), "utf8");
      expect(stored).toContain("clean body");
      // VCS metadata must not be copied into the immutable snapshot.
      expect(await lstat(join(versionDir, ".git")).catch(() => undefined)).toBeUndefined();
      expect(provenance.fileInventory.map((f) => f.path).some((p) => p.startsWith(".git/"))).toBe(false);
    });
  });

  test("a dirty worktree requires --include-worktree", async () => {
    if (!gitSupported) return;
    await withEnv(async (env, scratch) => {
      const repo = await makeGitRepo(scratch, "dirty", "committed body");
      await writeFile(join(repo, "SKILL.md"), `---
name: dirty
description: "demo: dirty"
---
uncommitted change
`, "utf8");
      await expect(installFromLocalPath(repo, { env })).rejects.toThrow(/uncommitted changes/);
    });
  });

  test("--include-worktree captures modified tracked content, marks dirtySource, and excludes untracked files", async () => {
    if (!gitSupported) return;
    await withEnv(async (env, scratch) => {
      const repo = await makeGitRepo(scratch, "dirty2", "committed body");
      await writeFile(join(repo, "SKILL.md"), `---
name: dirty2
description: "demo: dirty2"
---
uncommitted change
`, "utf8");
      await writeFile(join(repo, "UNTRACKED.txt"), "must not be snapshotted", "utf8");
      const [provenance] = await installFromLocalPath(repo, { includeWorktree: true, env });
      expect(provenance.dirtySource).toBe(true);
      const stored = await readFile(join(skillStoreDirectory(env), "dirty2", provenance.version, "SKILL.md"), "utf8");
      expect(stored).toContain("uncommitted change");
      expect(provenance.fileInventory.map((f) => f.path)).not.toContain("UNTRACKED.txt");
    });
  });

  test("the resolved commit is persisted as a SHA, not a floating ref", async () => {
    if (!gitSupported) return;
    await withEnv(async (env, scratch) => {
      const repo = await makeGitRepo(scratch, "pinned", "body");
      const [provenance] = await installFromLocalPath(repo, { env });
      const sidecar = await readProvenance("pinned", provenance.version, env);
      expect(sidecar?.resolvedCommit).toMatch(/^[0-9a-f]{40}$/);
      expect(sidecar?.sourceIdentity).toBe(repo);
    });
  });
});

describe("github url parsing", () => {
  test("parses plain https, .git, ssh, and tree URLs", () => {
    expect(parseGitHubUrl("https://github.com/owner/repo")).toEqual({ owner: "owner", repo: "repo" });
    expect(parseGitHubUrl("https://github.com/owner/repo.git")).toEqual({ owner: "owner", repo: "repo" });
    expect(parseGitHubUrl("git@github.com:owner/repo.git")).toEqual({ owner: "owner", repo: "repo" });
    expect(parseGitHubUrl("https://github.com/owner/repo/tree/main")).toEqual({ owner: "owner", repo: "repo", ref: "main" });
    expect(parseGitHubUrl("https://github.com/owner/repo/tree/v1.2.3/skills/foo")).toEqual({
      owner: "owner",
      repo: "repo",
      ref: "v1.2.3",
      subpath: "skills/foo",
    });
  });

  test("rejects a non-GitHub or local string", () => {
    expect(() => parseGitHubUrl("https://example.com/owner/repo")).toThrow();
    expect(() => parseGitHubUrl("./local/path")).toThrow();
  });

  test("isRemoteSource distinguishes URLs from local paths", () => {
    expect(isRemoteSource("https://github.com/owner/repo")).toBe(true);
    expect(isRemoteSource("git@github.com:owner/repo.git")).toBe(true);
    expect(isRemoteSource("./local/skill")).toBe(false);
    expect(isRemoteSource("/abs/local/skill")).toBe(false);
  });
});

describe("github acquisition", () => {
  test("installs a root skill from a GitHub URL via an injected fetch source", async () => {
    if (!tarSupported) return;
    await withEnv(async (env, scratch) => {
      const topLevel = "ghskill-abcdef0";
      const repoTree = join(scratch, "repo-tree");
      await writeSkillAt(join(repoTree, topLevel), "ghskill", "gh body");
      const tarball = await makeTarball(repoTree, topLevel);
      const fakeSha = "abcdef0123456789abcdef0123456789abcdef01";
      const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
        const target = String(input);
        if (target.includes("/commits/")) {
          return new Response(JSON.stringify({ sha: fakeSha }), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (target.includes("codeload.github.com")) return new Response(new Uint8Array(tarball), { status: 200 });
        return new Response("not found", { status: 404 });
      };
      const [provenance] = await installFromGitHub("https://github.com/owner/ghskill/tree/main", { fetchImpl, env });
      expect(provenance.sourceKind).toBe("github");
      expect(provenance.sourceIdentity).toBe("owner/ghskill");
      expect(provenance.resolvedCommit).toBe(fakeSha);
      expect(provenance.requestedRef).toBe("main");
      const stored = await readFile(join(skillStoreDirectory(env), "ghskill", provenance.version, "SKILL.md"), "utf8");
      expect(stored).toContain("gh body");
    });
  });

  test("the resolved commit is persisted as a SHA, never a floating ref", async () => {
    if (!tarSupported) return;
    await withEnv(async (env, scratch) => {
      const topLevel = "ghpinned-abcdef0";
      const repoTree = join(scratch, "repo-tree");
      await writeSkillAt(join(repoTree, topLevel), "ghpinned", "body");
      const tarball = await makeTarball(repoTree, topLevel);
      const fakeSha = "0123456789abcdef0123456789abcdef01234567";
      const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
        const target = String(input);
        if (target.includes("/commits/")) {
          return new Response(JSON.stringify({ sha: fakeSha }), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (target.includes("codeload.github.com")) return new Response(new Uint8Array(tarball), { status: 200 });
        return new Response("not found", { status: 404 });
      };
      const [provenance] = await installFromGitHub("https://github.com/owner/ghpinned/tree/release-1", { fetchImpl, env });
      const sidecar = await readProvenance("ghpinned", provenance.version, env);
      expect(sidecar?.resolvedCommit).toBe(fakeSha);
      expect(sidecar?.requestedRef).toBe("release-1");
    });
  });

  test("resolves the default branch when the URL has no /tree/<ref>", async () => {
    if (!tarSupported) return;
    await withEnv(async (env, scratch) => {
      const topLevel = "defbranch-abcdef0";
      const repoTree = join(scratch, "repo-tree");
      await writeSkillAt(join(repoTree, topLevel), "defbranch", "body");
      const tarball = await makeTarball(repoTree, topLevel);
      const fakeSha = "fedcba9876543210fedcba9876543210fedcba98";
      const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
        const target = String(input);
        if (target.includes("/repos/owner/defbranch") && !target.includes("/commits")) {
          return new Response(JSON.stringify({ default_branch: "main" }), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (target.includes("/commits/")) {
          return new Response(JSON.stringify({ sha: fakeSha }), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (target.includes("codeload.github.com")) return new Response(new Uint8Array(tarball), { status: 200 });
        return new Response("not found", { status: 404 });
      };
      const [provenance] = await installFromGitHub("https://github.com/owner/defbranch", { fetchImpl, env });
      expect(provenance.sourceKind).toBe("github");
      expect(provenance.requestedRef).toBe("main");
      expect(provenance.resolvedCommit).toBe(fakeSha);
    });
  });
});

describe("skill lifecycle (update + rollback)", () => {
  test("update re-acquires from source and keeps the old version for rollback", async () => {
    await withEnv(async (env, scratch) => {
      const src = await makeSource(scratch, "updatable", "original");
      const [first] = await installFromLocalPath(src, { env });
      await writeFile(join(src, "references", "glossary.md"), "updated gloss", "utf8");
      const result = await updateSkill("updatable", { env });
      expect(result.changed).toBe(true);
      expect(result.previousVersion).toBe(first!.version);
      expect(await listSkillVersions("updatable", env)).toHaveLength(2);
      const back = await rollbackSkill("updatable", env);
      expect(back).toBe(first!.version);
    });
  });

  test("update re-acquires a skill installed from a multi-skill source via its recorded skillRoot", async () => {
    await withEnv(async (env, scratch) => {
      await makeSource(join(scratch, "skills"), "alpha", "a");
      await makeSource(join(scratch, "skills"), "beta", "b");
      const [first] = await installFromLocalPath(scratch, { path: "skills/alpha", env });
      expect(first!.name).toBe("alpha");
      await writeFile(join(scratch, "skills", "alpha", "references", "glossary.md"), "updated gloss", "utf8");
      const result = await updateSkill("alpha", { env });
      expect(result.changed).toBe(true);
      expect(result.provenance.skillRoot).toBe("skills/alpha");
    });
  });
});
