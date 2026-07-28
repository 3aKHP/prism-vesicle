/**
 * Synchronize the bundled vesicle-docs Skill references from public source.
 *
 * Usage:
 *   bun run scripts/sync-bundled-skill-references.ts          # write mode
 *   bun run scripts/sync-bundled-skill-references.ts --check  # read-only check
 *
 * Reads only from the closed public-source allowlist (README.md, docs/user/**,
 * docs/dev/**, docs/examples/**), flattens each page into a deterministic
 * one-level resource name under references/, generates an index, and enforces
 * runtime bounds. Write mode replaces the generated references/ directory
 * atomically via staging + rename. Check mode exits non-zero on any drift.
 */

import { mkdir, lstat, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const PROJECT_ROOT = resolve(import.meta.dir, "..");
const SKILL_ROOT = join(PROJECT_ROOT, "host-assets", "skills", "vesicle-docs");
const REFERENCES_DIR = join(SKILL_ROOT, "references");

const MAX_RESOURCES = 200;
const MAX_RESOURCE_BYTES = 256 * 1024;

const SOURCE_ALLOWLIST = [
  { root: PROJECT_ROOT, pattern: "README.md" },
  { root: join(PROJECT_ROOT, "docs", "user"), pattern: "**" },
  { root: join(PROJECT_ROOT, "docs", "dev"), pattern: "**" },
  { root: join(PROJECT_ROOT, "docs", "examples"), pattern: "**" },
] as const;

interface SourceEntry {
  publicPath: string;
  absolutePath: string;
  resourceName: string;
}

function resourcePathToName(publicPath: string): string {
  const normalized = publicPath.replaceAll("\\", "/").toLowerCase();
  if (normalized === "readme.md") return "root-readme.md";
  const withoutDocs = normalized.replace(/^docs\//, "");
  const parts = withoutDocs.split("/");
  const flattened = parts.join("-");
  const withMd = flattened.endsWith(".md") ? flattened : `${flattened.replace(/\./g, "-")}.md`;
  return withMd;
}

async function collectRegularFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Symbolic link rejected in public source: ${full}`);
    }
    if (entry.isDirectory()) {
      files.push(...await collectRegularFiles(full));
    } else if (entry.isFile()) {
      files.push(full);
    } else {
      throw new Error(`Non-regular file rejected in public source: ${full}`);
    }
  }
  return files;
}

async function buildInventory(): Promise<SourceEntry[]> {
  const entries: SourceEntry[] = [];
  const seen = new Set<string>();

  const readmePath = join(PROJECT_ROOT, "README.md");
  const readmeStat = await lstat(readmePath).catch(() => undefined);
  if (readmeStat?.isSymbolicLink()) throw new Error("README.md must not be a symbolic link.");
  if (readmeStat?.isFile()) {
    const name = resourcePathToName("README.md");
    if (seen.has(name)) throw new Error(`Resource name collision: ${name}`);
    seen.add(name);
    entries.push({ publicPath: "README.md", absolutePath: readmePath, resourceName: name });
  }

  for (const source of SOURCE_ALLOWLIST.slice(1)) {
    const rootStat = await lstat(source.root).catch(() => undefined);
    if (rootStat?.isSymbolicLink()) throw new Error(`Source root must not be a symbolic link: ${source.root}`);
    if (!rootStat?.isDirectory()) continue;
    const files = await collectRegularFiles(source.root);
    for (const abs of files) {
      const publicPath = relative(PROJECT_ROOT, abs).replaceAll("\\", "/");
      const name = resourcePathToName(publicPath);
      if (seen.has(name)) throw new Error(`Resource name collision: "${name}" from "${publicPath}"`);
      seen.add(name);
      entries.push({ publicPath, absolutePath: abs, resourceName: name });
    }
  }

  entries.sort((a, b) => a.resourceName.localeCompare(b.resourceName));
  return entries;
}

function generatedMarker(publicPath: string): string {
  return `<!-- Generated from ${publicPath} — do not edit. -->`;
}

async function generateResourceContent(entry: SourceEntry): Promise<string> {
  const buffer = await readFile(entry.absolutePath);
  if (buffer.includes(0)) {
    throw new Error(`Binary content (NUL byte) rejected: ${entry.publicPath}`);
  }
  const text = buffer.toString("utf8");
  if (text.includes("\uFFFD")) {
    throw new Error(`Invalid UTF-8 content rejected: ${entry.publicPath}`);
  }
  return `${generatedMarker(entry.publicPath)}\n\n${text}`;
}

function extractTitle(content: string, fallback: string): string {
  const match = /^#\s+(.+)$/m.exec(content);
  return match ? match[1]!.trim() : fallback;
}

function categorize(publicPath: string): { section: string; language: string } {
  if (publicPath === "README.md") return { section: "root", language: "en" };
  if (publicPath.startsWith("docs/user/zh-CN/")) return { section: "user", language: "zh-CN" };
  if (publicPath.startsWith("docs/user/en/")) return { section: "user", language: "en" };
  if (publicPath.startsWith("docs/dev/")) return { section: "dev", language: "en" };
  if (publicPath.startsWith("docs/examples/")) return { section: "examples", language: "en" };
  return { section: "other", language: "en" };
}

async function generateIndex(entries: SourceEntry[], contents: Map<string, string>): Promise<string> {
  const lines: string[] = [
    "<!-- Generated index — do not edit. Run: bun run skills:docs:sync -->",
    "",
    "# Vesicle Documentation Index",
    "",
    "Version-matched public documentation snapshot for the vesicle-docs Skill.",
    "",
    "## Routing guidance",
    "",
    "- User-facing questions: prefer the matching-language user manual (`docs/user/zh-CN` or `docs/user/en`).",
    "- Developer/runtime questions: use `docs/dev/` contracts.",
    "- Configuration shapes: `docs/examples/` are authoritative examples, not user state.",
    "- Overview/installation: start from `README.md`.",
    "- If information is missing, report the gap rather than inventing an answer.",
    "",
  ];

  const sections: Record<string, SourceEntry[]> = {};
  for (const entry of entries) {
    const { section } = categorize(entry.publicPath);
    if (!sections[section]) sections[section] = [];
    sections[section]!.push(entry);
  }

  const sectionOrder = ["root", "user", "dev", "examples", "other"];
  const sectionTitles: Record<string, string> = {
    root: "Root",
    user: "User Manual",
    dev: "Developer Contracts",
    examples: "Examples",
    other: "Other",
  };

  for (const section of sectionOrder) {
    const group = sections[section];
    if (!group || group.length === 0) continue;
    lines.push(`## ${sectionTitles[section] ?? section}`, "");
    for (const entry of group) {
      const content = contents.get(entry.resourceName) ?? "";
      const title = extractTitle(content, entry.resourceName.replace(/\.md$/, ""));
      const { language } = categorize(entry.publicPath);
      lines.push(`- \`${entry.publicPath}\` → \`references/${entry.resourceName}\` — ${title} [${language}]`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

async function validateBounds(entries: SourceEntry[], contents: Map<string, string>): Promise<string[]> {
  const errors: string[] = [];
  if (entries.length > MAX_RESOURCES) {
    errors.push(`Resource count ${entries.length} exceeds the ${MAX_RESOURCES} limit.`);
  }
  for (const [name, content] of contents) {
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > MAX_RESOURCE_BYTES) {
      errors.push(`Resource "${name}" is ${bytes} bytes, exceeding the ${MAX_RESOURCE_BYTES}-byte limit.`);
    }
    if (content.includes("\0")) {
      errors.push(`Resource "${name}" contains NUL bytes.`);
    }
  }
  for (const entry of entries) {
    if (entry.resourceName.includes("..") || entry.resourceName.includes("/")) {
      errors.push(`Resource name "${entry.resourceName}" is not a safe single-level filename.`);
    }
  }
  return errors;
}

function containsCheckoutPath(content: string, projectRoot: string): boolean {
  return content.includes(projectRoot);
}

async function run(): Promise<void> {
  const checkMode = process.argv.includes("--check");
  const entries = await buildInventory();
  const contents = new Map<string, string>();
  for (const entry of entries) {
    contents.set(entry.resourceName, await generateResourceContent(entry));
  }
  const indexContent = await generateIndex(entries, contents);
  contents.set("index.md", indexContent);

  const errors = await validateBounds(entries, contents);
  for (const [, content] of contents) {
    if (containsCheckoutPath(content, PROJECT_ROOT)) {
      errors.push("Generated content contains the local checkout path.");
      break;
    }
  }
  if (errors.length > 0) {
    for (const error of errors) console.error(`ERROR: ${error}`);
    process.exit(1);
  }

  if (checkMode) {
    const drift: string[] = [];
    const existingFiles = await readdir(REFERENCES_DIR).catch(() => [] as string[]);
    const expectedNames = new Set(contents.keys());
    for (const file of existingFiles) {
      if (!expectedNames.has(file)) drift.push(`extra: references/${file}`);
    }
    for (const [name, expected] of [...contents.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const actual = await readFile(join(REFERENCES_DIR, name), "utf8").catch(() => undefined);
      if (actual === undefined) {
        drift.push(`missing: references/${name}`);
      } else if (actual !== expected) {
        drift.push(`changed: references/${name}`);
      }
    }
    if (drift.length > 0) {
      console.error("Bundled skill references are out of sync:");
      for (const item of drift) console.error(`  ${item}`);
      console.error("Run: bun run skills:docs:sync");
      process.exit(1);
    }
    console.log(`OK: ${contents.size} references are in sync.`);
    return;
  }

  const stagingDir = join(SKILL_ROOT, `.references-staging-${process.pid}`);
  const oldDir = join(SKILL_ROOT, `.references-old-${process.pid}`);
  await rm(stagingDir, { recursive: true, force: true });
  await rm(oldDir, { recursive: true, force: true });
  try {
    await mkdir(stagingDir, { recursive: true });
    for (const [name, content] of [...contents.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      await writeFile(join(stagingDir, name), content, "utf8");
    }
    const hadOld = await stat(REFERENCES_DIR).catch(() => undefined);
    if (hadOld) await rename(REFERENCES_DIR, oldDir);
    try {
      await rename(stagingDir, REFERENCES_DIR);
    } catch (error) {
      if (hadOld) await rename(oldDir, REFERENCES_DIR).catch(() => {});
      throw error;
    }
    await rm(oldDir, { recursive: true, force: true });
    console.log(`Synced ${contents.size} references to host-assets/skills/vesicle-docs/references/.`);
  } finally {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    await rm(oldDir, { recursive: true, force: true }).catch(() => {});
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
