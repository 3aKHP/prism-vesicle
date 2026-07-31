import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, lstat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { ToolCall } from "../../../src/core/tools/types";
import { executeActivateSkillTool, executeRunSkillScriptTool, clearSessionActivations } from "../../../src/core/skills";
import type { ResolvedSkillCatalog } from "../../../src/core/skills";
import { buildCatalog } from "../../../src/skills";
import { loadSkill } from "../../../src/skills";
import { configureSelfInvocation, clearSelfInvocation } from "../../../src/core/runtime/self-invocation";

const SKILLIFY_ROOT = resolve(import.meta.dir, "../../../host-assets/skills/skillify");
const CLI_ENTRY = resolve(import.meta.dir, "../../../src/cli/main.ts");

let projectRoot: string;
let sessionId: string;

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), "vesicle-skillify-int-"));
  sessionId = randomUUID();
  configureSelfInvocation({ executablePath: process.execPath, entrypoint: CLI_ENTRY });
});

afterEach(async () => {
  clearSessionActivations(sessionId);
  clearSelfInvocation();
  await rm(projectRoot, { recursive: true, force: true }).catch(() => undefined);
});

async function writeDraft(name: string): Promise<void> {
  const draftRoot = join(projectRoot, "tmp", "skillify", name);
  await mkdir(join(draftRoot, "references"), { recursive: true });
  await mkdir(join(draftRoot, "scripts"), { recursive: true });
  await writeFile(
    join(draftRoot, "SKILL.md"),
    `---\nname: ${name}\ndescription: "${name} 工作流 Skill"\n---\n\n# ${name}\n\n这是一个测试用 Skill 草稿。\n`,
  );
  await writeFile(join(draftRoot, "references", "guide.md"), `指南 for ${name}.`);
  await writeFile(join(draftRoot, "scripts", "run.sh"), "#!/bin/sh\necho run\n");
}

// Inline writeFile to avoid an extra import line shuffle.
async function writeFile(path: string, content: string): Promise<void> {
  const { writeFile: wf } = await import("node:fs/promises");
  await wf(path, content, "utf8");
}

function call(name: string, args: unknown): ToolCall {
  return { id: `call-${randomUUID()}`, name, arguments: JSON.stringify(args) };
}

async function skillifyCatalog(): Promise<ResolvedSkillCatalog> {
  const loaded = await loadSkill(SKILLIFY_ROOT, "host");
  if (!loaded.parsed.ok) throw new Error("skillify failed to load");
  return { catalog: buildCatalog([loaded]), byName: new Map([[loaded.name, loaded]]) };
}

async function runWrapper(operation: string, ...args: string[]): Promise<{ ok: boolean; content: string }> {
  return runWrapperScript("scripts/publish_skill.sh", operation, ...args);
}

async function runWrapperScript(script: string, operation: string, ...args: string[]): Promise<{ ok: boolean; content: string }> {
  const catalog = await skillifyCatalog();
  const activation = await executeActivateSkillTool(call("activate_skill", { name: "skillify" }), { catalog, sessionId });
  expect(activation.ok).toBe(true);
  const result = await executeRunSkillScriptTool(projectRoot, call("run_skill_script", {
    skill: "skillify",
    path: script,
    args: [operation, ...args],
  }), { catalog, sessionId });
  return { ok: result.ok, content: result.content };
}

/** Extract the JSON object from a wrapper tool result's stdout section. */
function parseWrapperJson(content: string): Record<string, unknown> | undefined {
  const match = content.match(/stdout:\n(\{.*\})\n\n/s);
  if (!match) return undefined;
  try {
    return JSON.parse(match[1]!);
  } catch {
    return undefined;
  }
}

describe("skillify wrapper integration (.sh)", () => {
  test.skipIf(process.platform === "win32")("validate returns a valid JSON envelope with hash, version, and file count", async () => {
    await writeDraft("validate-test");
    const result = await runWrapper("validate", "tmp/skillify/validate-test");
    expect(result.ok).toBe(true);
    const json = parseWrapperJson(result.content);
    expect(json).toBeDefined();
    expect(json!.ok).toBe(true);
    expect(json!.operation).toBe("validate");
    expect(json!.name).toBe("validate-test");
    expect(json!.bundleSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(json!.version).toMatch(/^sha-/);
    expect(json!.fileCount).toBe(3); // SKILL.md + references/guide.md + scripts/run.sh
    expect(json!.source).toBe("tmp/skillify/validate-test");
  }, 30_000);

  test.skipIf(process.platform === "win32")("publish project creates .agents/skills/<name> byte-exact and retains the draft", async () => {
    await writeDraft("publish-test");
    const result = await runWrapper("publish", "tmp/skillify/publish-test", "project");
    expect(result.ok).toBe(true);
    const json = parseWrapperJson(result.content);
    expect(json).toBeDefined();
    expect(json!.ok).toBe(true);
    expect(json!.operation).toBe("publish");
    expect(json!.target).toBe("project");
    expect(json!.destination).toBe(".agents/skills/publish-test");

    // Published bundle exists and matches the draft.
    const publishedBody = await readFile(join(projectRoot, ".agents", "skills", "publish-test", "SKILL.md"), "utf8");
    const draftBody = await readFile(join(projectRoot, "tmp", "skillify", "publish-test", "SKILL.md"), "utf8");
    expect(publishedBody).toBe(draftBody);

    // No staging residue.
    const entries = await readdir(join(projectRoot, ".agents", "skills"));
    expect(entries.filter((name) => name.startsWith(".staging-"))).toHaveLength(0);

    // Draft retained.
    expect(await lstat(join(projectRoot, "tmp", "skillify", "publish-test", "SKILL.md"))).toBeDefined();
  }, 30_000);

  test.skipIf(process.platform === "win32")("publish project a second time fails with target-exists and retains the draft", async () => {
    await writeDraft("collision-test");
    await runWrapper("publish", "tmp/skillify/collision-test", "project");
    const result = await runWrapper("publish", "tmp/skillify/collision-test", "project");
    expect(result.ok).toBe(false);
    const json = parseWrapperJson(result.content);
    expect(json).toBeDefined();
    expect(json!.ok).toBe(false);
    // The diagnostics array carries the target-exists code.
    const diagnostics = json!.diagnostics as Array<{ code: string }>;
    expect(diagnostics.some((d) => d.code === "target-exists")).toBe(true);
    // Draft retained.
    expect(await lstat(join(projectRoot, "tmp", "skillify", "collision-test", "SKILL.md"))).toBeDefined();
  }, 30_000);

  test.skipIf(process.platform === "win32")("rejects wrong arity before invoking the CLI", async () => {
    await writeDraft("arity-test");
    const result = await runWrapper("validate");
    expect(result.ok).toBe(false);
    expect(result.content).toContain("Exit code: 2");
  }, 15_000);

  test.skipIf(process.platform === "win32")("self-invocation failure remains valid JSON for hostile source text", async () => {
    const child = Bun.spawn([
      "/bin/sh",
      join(SKILLIFY_ROOT, "scripts", "publish_skill.sh"),
      "validate",
      'tmp/skillify/bad"name',
    ], {
      cwd: projectRoot,
      env: { ...process.env, VESICLE_SELF_EXECUTABLE: undefined, VESICLE_SELF_ENTRYPOINT: undefined },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    expect(exitCode).toBe(1);
    expect(JSON.parse(stdout)).toMatchObject({ operation: "validate", ok: false, source: "" });
  });
});

describe("skillify wrapper integration (.ps1)", () => {
  test.skipIf(process.platform !== "win32")("validates, publishes, rejects collision, and preserves Unicode through native PowerShell", async () => {
    await writeDraft("powershell-native");

    const validated = await runWrapperScript("scripts/publish_skill.ps1", "validate", "tmp/skillify/powershell-native");
    expect(validated.ok).toBe(true);
    expect(parseWrapperJson(validated.content)).toMatchObject({
      operation: "validate",
      ok: true,
      name: "powershell-native",
      source: "tmp/skillify/powershell-native",
      fileCount: 3,
    });

    const published = await runWrapperScript("scripts/publish_skill.ps1", "publish", "tmp/skillify/powershell-native", "project");
    expect(published.ok).toBe(true);
    expect(parseWrapperJson(published.content)).toMatchObject({
      operation: "publish",
      ok: true,
      target: "project",
      destination: ".agents/skills/powershell-native",
    });
    expect(await readFile(join(projectRoot, ".agents", "skills", "powershell-native", "references", "guide.md"), "utf8")).toContain("指南");
    expect(await readFile(join(projectRoot, "tmp", "skillify", "powershell-native", "SKILL.md"), "utf8")).toContain("这是一个测试用 Skill 草稿");

    const collision = await runWrapperScript("scripts/publish_skill.ps1", "publish", "tmp/skillify/powershell-native", "project");
    expect(collision.ok).toBe(false);
    const diagnostics = parseWrapperJson(collision.content)!.diagnostics as Array<{ code: string }>;
    expect(diagnostics.some((diagnostic) => diagnostic.code === "target-exists")).toBe(true);
  }, 60_000);
});
