import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadSkill } from "../../../src/skills";
import type { LoadedSkill } from "../../../src/skills";
import { buildCatalog } from "../../../src/skills";
import type { ResolvedSkillCatalog } from "../../../src/core/skills";

export async function makeScratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), "vesicle-skills-runtime-"));
}

/** Write one skill root with a valid SKILL.md plus optional extra files. */
export async function writeSkill(
  scratch: string,
  name: string,
  options: { description?: string; body?: string; files?: Record<string, string | Uint8Array> } = {},
): Promise<string> {
  const root = join(scratch, "roots", name);
  await mkdir(root, { recursive: true });
  for (const [rel, content] of Object.entries(options.files ?? {})) {
    const target = join(root, ...rel.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  const description = options.description ?? `${name} description`;
  const body = options.body ?? `# ${name}\n\nProcedure body for ${name}.`;
  await writeFile(join(root, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`);
  return root;
}

export async function loadWritten(root: string): Promise<LoadedSkill> {
  const loaded = await loadSkill(root, "user");
  if (!loaded.parsed.ok) throw new Error(`test skill failed to load: ${loaded.parsed.diagnostics.map((d) => d.message).join("; ")}`);
  return loaded;
}

/** Build a ResolvedSkillCatalog directly from loaded skills (no harness/env). */
export function catalogFor(...skills: LoadedSkill[]): ResolvedSkillCatalog {
  return {
    catalog: buildCatalog(skills),
    byName: new Map(skills.map((skill) => [skill.name, skill])),
  };
}
