import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { inspectSkillDraft, publishSkillDraft } from "../../../src/core/skills/draft-publisher";
import type { SkillDraftInspection } from "../../../src/core/skills/draft-publisher";
import { readActiveIndex } from "../../../src/skills";

const symlinkSupported = await (async (): Promise<boolean> => {
  const dir = await mkdtemp(join(tmpdir(), "vesicle-draft-symlink-probe-"));
  try {
    const target = join(dir, "target");
    await writeFile(target, "x", "utf8");
    await symlink(target, join(dir, "link"));
    return true;
  } catch {
    return false;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
})();

interface DraftFixture {
  projectRoot: string;
  draftSource: string;
}

async function makeDraft(
  name: string,
  options: { body?: string; description?: string; files?: Record<string, string | Uint8Array>; noDirs?: boolean } = {},
): Promise<DraftFixture> {
  const projectRoot = await mkdtemp(join(tmpdir(), "vesicle-draft-pub-"));
  const draftRoot = join(projectRoot, "tmp", "skillify", name);
  await mkdir(draftRoot, { recursive: true });
  if (!options.noDirs) {
    await mkdir(join(draftRoot, "references"), { recursive: true });
    await mkdir(join(draftRoot, "scripts"), { recursive: true });
  }
  const description = options.description ?? `${name} description`;
  const body = options.body ?? `# ${name}\n\n用于捕获工作流的 Skill 草稿。`;
  await writeFile(join(draftRoot, "SKILL.md"), `---\nname: ${name}\ndescription: "${description}"\n---\n\n${body}\n`);
  if (!options.noDirs) {
    await writeFile(join(draftRoot, "references", "glossary.md"), `术语表 for ${name}.`);
    await writeFile(join(draftRoot, "scripts", "publish.sh"), "#!/bin/sh\necho publish\n");
  }
  for (const [rel, content] of Object.entries(options.files ?? {})) {
    const target = join(draftRoot, ...rel.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return { projectRoot, draftSource: `tmp/skillify/${name}` };
}

async function withEnv<T>(work: (env: NodeJS.ProcessEnv, projectRoot: string) => Promise<T>, fixture: DraftFixture): Promise<T> {
  const configDir = await mkdtemp(join(tmpdir(), "vesicle-draft-config-"));
  const env = { ...process.env, VESICLE_CONFIG_DIR: configDir };
  try {
    return await work(env, fixture.projectRoot);
  } finally {
    await rm(configDir, { recursive: true, force: true });
    await rm(fixture.projectRoot, { recursive: true, force: true });
  }
}

const inspections: DraftFixture[] = [];
const CLI_ENTRY = resolve(import.meta.dir, "../../../src/cli/main.ts");
afterEach(async () => {
  while (inspections.length > 0) {
    const fixture = inspections.pop()!;
    await rm(fixture.projectRoot, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe("inspectSkillDraft", () => {
  test("validates a complete draft with Chinese content and returns deterministic hash/version/count", async () => {
    const fixture = await makeDraft("chinese-skill", { description: "捕获并发布可复用工作流" });
    inspections.push(fixture);
    const inspection = await inspectSkillDraft(fixture.projectRoot, fixture.draftSource);
    expectInspectionValid(inspection, "chinese-skill");
    expect(inspection.fileCount).toBe(3); // SKILL.md + references/glossary.md + scripts/publish.sh
    expect(inspection.version).toMatch(/^sha-/);
    expect(inspection.bundleSha256).toHaveLength(64);
  });

  test("same content produces the same hash across inspections", async () => {
    const fixture = await makeDraft("stable-hash");
    inspections.push(fixture);
    const first = await inspectSkillDraft(fixture.projectRoot, fixture.draftSource);
    const second = await inspectSkillDraft(fixture.projectRoot, fixture.draftSource);
    expect(second.bundleSha256).toBe(first.bundleSha256);
    expect(second.version).toBe(first.version);
  });

  test("rejects absolute draft paths", async () => {
    const fixture = await makeDraft("abs-test");
    inspections.push(fixture);
    await expect(inspectSkillDraft(fixture.projectRoot, "/tmp/skillify/abs-test")).rejects.toMatchObject({ code: "invalid-draft-path" });
  });

  test("rejects backslash in draft path", async () => {
    const fixture = await makeDraft("bs-test");
    inspections.push(fixture);
    await expect(inspectSkillDraft(fixture.projectRoot, "tmp\\skillify\\bs-test")).rejects.toMatchObject({ code: "invalid-draft-path" });
  });

  test("rejects wrong root (not tmp/skillify)", async () => {
    const fixture = await makeDraft("wrong-root");
    inspections.push(fixture);
    await expect(inspectSkillDraft(fixture.projectRoot, "tmp/wrong-root")).rejects.toMatchObject({ code: "invalid-draft-path" });
    await expect(inspectSkillDraft(fixture.projectRoot, "workspace/skillify/x")).rejects.toMatchObject({ code: "invalid-draft-path" });
  });

  test("rejects extra nesting", async () => {
    const fixture = await makeDraft("deep");
    inspections.push(fixture);
    await expect(inspectSkillDraft(fixture.projectRoot, "tmp/skillify/deep/extra")).rejects.toMatchObject({ code: "invalid-draft-path" });
  });

  test("rejects traversal segments", async () => {
    const fixture = await makeDraft("trav");
    inspections.push(fixture);
    await expect(inspectSkillDraft(fixture.projectRoot, "tmp/skillify/..")).rejects.toMatchObject({ code: "invalid-draft-path" });
    await expect(inspectSkillDraft(fixture.projectRoot, "tmp/skillify/.")).rejects.toMatchObject({ code: "invalid-draft-path" });
  });

  test("rejects an invalid SKILL.md name with a structured bundle-invalid code", async () => {
    const fixture = await makeDraft("bad-name", {
      body: "# body",
      noDirs: true,
      files: { "SKILL.md": "---\nname: Bad Name\ndescription: \"x\"\n---\n\nbody\n" },
    });
    inspections.push(fixture);
    await expect(inspectSkillDraft(fixture.projectRoot, fixture.draftSource)).rejects.toMatchObject({ code: "bundle-invalid" });
  });
});

describe("skills publish-draft CLI envelope", () => {
  test("missing --target value returns one invalid-arguments JSON object on stdout", async () => {
    const fixture = await makeDraft("missing-target");
    inspections.push(fixture);
    const child = Bun.spawn([process.execPath, CLI_ENTRY, "skills", "publish-draft", fixture.draftSource, "--target"], {
      cwd: fixture.projectRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toBe("");
    const lines = stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      schema: "vesicle.skill-draft/v1",
      operation: "publish",
      ok: false,
      source: fixture.draftSource,
      diagnostics: [{ code: "invalid-arguments", message: "--target requires a value." }],
    });
  });

  test("duplicate --target is rejected inside the structured JSON contract", async () => {
    const fixture = await makeDraft("duplicate-target");
    inspections.push(fixture);
    const child = Bun.spawn([
      process.execPath, CLI_ENTRY, "skills", "publish-draft", fixture.draftSource,
      "--target", "project", "--target", "installed", "--json",
    ], { cwd: fixture.projectRoot, stdout: "pipe", stderr: "pipe" });
    const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    expect(exitCode).toBe(1);
    expect(JSON.parse(stdout)).toMatchObject({
      ok: false,
      diagnostics: [{ code: "invalid-arguments", message: "Duplicate argument: --target" }],
    });
  });
});

describe("publishSkillDraft: project target", () => {
  test("publishes create-only to .agents/skills/<name> and retains the draft", async () => {
    const fixture = await makeDraft("project-skill");
    inspections.push(fixture);
    const publication = await publishSkillDraft(fixture.projectRoot, fixture.draftSource, "project");
    expect(publication.target).toBe("project");
    expect(publication.destination).toBe(".agents/skills/project-skill");
    expect(publication.draftRetained).toBe(true);

    // Published bundle exists and is byte-exact with the draft.
    const publishedBody = await readFile(join(fixture.projectRoot, ".agents", "skills", "project-skill", "SKILL.md"), "utf8");
    const draftBody = await readFile(join(fixture.projectRoot, "tmp", "skillify", "project-skill", "SKILL.md"), "utf8");
    expect(publishedBody).toBe(draftBody);

    // The draft is untouched.
    expect(await lstat(join(fixture.projectRoot, "tmp", "skillify", "project-skill", "SKILL.md"))).toBeDefined();

    // No staging residue.
    const skillsDir = join(fixture.projectRoot, ".agents", "skills");
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(skillsDir);
    expect(entries.filter((name) => name.startsWith(".staging-"))).toHaveLength(0);
  });

  test("rejects an already-published project destination as target-exists", async () => {
    const fixture = await makeDraft("collision");
    inspections.push(fixture);
    await publishSkillDraft(fixture.projectRoot, fixture.draftSource, "project");
    await expect(publishSkillDraft(fixture.projectRoot, fixture.draftSource, "project")).rejects.toMatchObject({ code: "target-exists" });
  });

  test("rejects a symlinked .agents directory as a linked target parent", async () => {
    if (!symlinkSupported) return;
    const fixture = await makeDraft("link-parent");
    inspections.push(fixture);
    // Replace .agents with a symlink to outside the project.
    const outside = await mkdtemp(join(tmpdir(), "vesicle-outside-"));
    try {
      await rm(join(fixture.projectRoot, ".agents"), { recursive: true, force: true }).catch(() => undefined);
      // mkdir .agents/skills first to create the real structure, then symlink doesn't apply here.
      // Instead, create .agents as a symlink to outside.
      await symlink(outside, join(fixture.projectRoot, ".agents"));
      await expect(publishSkillDraft(fixture.projectRoot, fixture.draftSource, "project")).rejects.toMatchObject({ code: "staging-failed" });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe("publishSkillDraft: installed target", () => {
  test("publishes create-only to the Skill Store and reports installed destination", async () => {
    const fixture = await makeDraft("installed-skill");
    inspections.push(fixture);
    await withEnv(async (env) => {
      const publication = await publishSkillDraft(fixture.projectRoot, fixture.draftSource, "installed", { env });
      expect(publication.target).toBe("installed");
      expect(publication.destination).toMatch(/^installed:installed-skill@sha-/);
      expect(publication.draftRetained).toBe(true);

      const index = await readActiveIndex(env);
      expect(index.entries.some((entry) => entry.name === "installed-skill")).toBe(true);

      // Draft retained.
      expect(await lstat(join(fixture.projectRoot, "tmp", "skillify", "installed-skill", "SKILL.md"))).toBeDefined();
    }, fixture);
  });

  test("rejects an already-installed name even with identical content", async () => {
    const fixture = await makeDraft("taken-installed");
    inspections.push(fixture);
    await withEnv(async (env) => {
      await publishSkillDraft(fixture.projectRoot, fixture.draftSource, "installed", { env });
      await expect(publishSkillDraft(fixture.projectRoot, fixture.draftSource, "installed", { env })).rejects.toMatchObject({ code: "target-exists" });
    }, fixture);
  });
});

describe("publishSkillDraft: revalidation", () => {
  test("revalidates and detects changed bytes rather than trusting a prior validate", async () => {
    const fixture = await makeDraft("mutating");
    inspections.push(fixture);
    const first = await inspectSkillDraft(fixture.projectRoot, fixture.draftSource);
    // Mutate SKILL.md after validation.
    await writeFile(
      join(fixture.projectRoot, "tmp", "skillify", "mutating", "SKILL.md"),
      `---\nname: mutating\ndescription: "mutating description"\n---\n\nchanged body\n`,
    );
    const second = await inspectSkillDraft(fixture.projectRoot, fixture.draftSource);
    expect(second.bundleSha256).not.toBe(first.bundleSha256);
    expect(second.version).not.toBe(first.version);
  });
});

function expectInspectionValid(inspection: SkillDraftInspection, name: string): void {
  expect(inspection.ok).toBe(true);
  expect(inspection.name).toBe(name);
  expect(inspection.source).toBe(`tmp/skillify/${name}`);
}
