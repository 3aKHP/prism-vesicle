import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { executeFileTool } from "../tools";
import { resolveValidators, runValidators } from "../validators/registry";
import type { ValidationResult } from "../validators/registry";
import { artifactRootIndex, artifactRoots } from "./roots";

export { artifactRoots, sourceMaterialRoot, writableProjectRoots } from "./roots";
const PREVIEW_MAX_LINES = 80;
const PREVIEW_MAX_CHARS = 6_000;

export type ArtifactEntry = {
  path: string;
  updatedAt: string;
};

export type ArtifactValidation = {
  ok: boolean;
  results: Array<{ name: string; result: ValidationResult }>;
};

export type ArtifactPreview = ArtifactEntry & {
  preview: string;
  truncated: boolean;
  validation?: ArtifactValidation;
};

export async function scanArtifacts(rootDir: string): Promise<ArtifactEntry[]> {
  const entries: ArtifactEntry[] = [];

  for (const root of artifactRoots) {
    await scanArtifactDir(rootDir, join(rootDir, root), entries).catch(() => undefined);
  }

  return sortArtifacts(entries).slice(0, 12);
}

/** Keep sidebar grouping and /artifact numeric selection in one stable order. */
export function sortArtifacts(entries: ArtifactEntry[]): ArtifactEntry[] {
  return [...entries].sort((left, right) => {
    const rootOrder = artifactRootIndex(left.path) - artifactRootIndex(right.path);
    return rootOrder || right.updatedAt.localeCompare(left.updatedAt) || left.path.localeCompare(right.path);
  });
}

export async function loadArtifactPreview(
  rootDir: string,
  artifact: ArtifactEntry,
  options: { validate?: boolean } = {},
): Promise<ArtifactPreview> {
  const result = await executeFileTool(rootDir, {
    id: "artifact-preview",
    name: "read_file",
    arguments: JSON.stringify({ path: artifact.path }),
  });
  if (!result.ok) throw new Error(result.content);

  const { preview, truncated } = previewArtifactContent(result.content);
  const validation = options.validate ? validateArtifactContent(result.content) : undefined;
  return {
    ...artifact,
    preview,
    truncated,
    ...(validation ? { validation } : {}),
  };
}

export function previewArtifactContent(content: string): { preview: string; truncated: boolean } {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  const lineBounded = lines.slice(0, PREVIEW_MAX_LINES).join("\n");
  const preview = lineBounded.slice(0, PREVIEW_MAX_CHARS);
  return {
    preview: preview.trim().length > 0 ? preview : "(empty)",
    truncated: lines.length > PREVIEW_MAX_LINES || lineBounded.length > PREVIEW_MAX_CHARS,
  };
}

async function scanArtifactDir(rootDir: string, dir: string, entries: ArtifactEntry[]): Promise<void> {
  const children = await readdir(dir, { withFileTypes: true });
  for (const child of children) {
    if (child.name === ".gitkeep") continue;
    const fullPath = join(dir, child.name);
    if (child.isDirectory()) {
      await scanArtifactDir(rootDir, fullPath, entries);
      continue;
    }
    if (!child.isFile()) continue;
    const info = await stat(fullPath);
    entries.push({
      path: relative(rootDir, fullPath).replace(/\\/g, "/"),
      updatedAt: info.mtime.toISOString(),
    });
  }
}

function validateArtifactContent(content: string): ArtifactValidation | undefined {
  const names = selectArtifactValidators(content);
  if (names.length === 0) return undefined;
  return runValidators(resolveValidators(names), content);
}

function selectArtifactValidators(content: string): string[] {
  const keys = frontmatterKeys(content);
  if (keys.size === 0) return [];
  if (keys.has("scenario_name")) return ["scenario-card"];
  if (keys.has("name") && keys.has("archetype")) return ["character-card"];
  return ["character-card", "scenario-card"];
}

function frontmatterKeys(content: string): Set<string> {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith("---")) return new Set();
  const lines = trimmed.split(/\r?\n/);
  const keys = new Set<string>();
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index].trim();
    if (line === "---") break;
    const colon = line.indexOf(":");
    if (colon > 0) keys.add(line.slice(0, colon).trim());
  }
  return keys;
}
