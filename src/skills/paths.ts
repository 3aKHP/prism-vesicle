/**
 * Skill-relative path hardening and bounded resource enumeration.
 *
 * A Skill lives behind a virtual root: every supporting resource path is
 * skill-relative, shallow, and resolved only inside that root. Absolute paths,
 * `..` escapes, NUL, backslashes, empty/dot segments, symbolic links, devices,
 * and sockets are rejected so a Skill cannot read arbitrary host files. The
 * same hardening is reused by the parser (validating any declared reference),
 * the loader (enumerating the inventory), the store (hashing a snapshot), and
 * the future Phase 2 `read_skill_resource` tool.
 */

import { lstat, readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import { join, posix, relative, sep } from "node:path";
import type { SkillDiagnostic, SkillResource, SkillResourceKind } from "./types";

/** Maximum supporting-resource entries indexed per Skill (research §2). */
export const MAX_RESOURCES_PER_SKILL = 200;

/** Maximum size of a single text reference before it is flagged oversized. */
export const MAX_TEXT_REFERENCE_BYTES = 256 * 1024;

const TEXT_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".text",
  ".json",
  ".yaml",
  ".yml",
  ".csv",
  ".tsv",
  ".html",
  ".htm",
  ".css",
  ".js",
  ".ts",
  ".tsx",
  ".jsx",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".toml",
  ".ini",
  ".xml",
  ".log",
]);

/**
 * Validate a skill-relative path string. Throws a descriptive error on any
 * unsafe shape. Backslashes are rejected outright because they are a path
 * separator on Windows but a legal filename character on POSIX, so accepting
 * them would introduce platform-dependent path normalization ambiguity.
 */
export function assertSafeRelativePath(skillRelativePath: string): void {
  if (!skillRelativePath || skillRelativePath.includes("\0")) {
    throw new Error("Skill path is required.");
  }
  if (skillRelativePath.includes("\\")) {
    throw new Error(`Skill path must use forward slashes: ${skillRelativePath}.`);
  }
  if (skillRelativePath.startsWith("/") || /^[A-Za-z]:\//.test(skillRelativePath)) {
    throw new Error(`Skill path must be relative: ${skillRelativePath}.`);
  }
  const parts = skillRelativePath.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`Unsafe skill path: ${skillRelativePath}.`);
  }
  if (posix.normalize(skillRelativePath) !== skillRelativePath) {
    throw new Error(`Ambiguous skill path: ${skillRelativePath}.`);
  }
}

/** Classify a skill-relative resource path by the conventional directory. */
export function classifyResource(skillRelativePath: string): SkillResourceKind {
  const top = skillRelativePath.split("/")[0] ?? "";
  if (top === "references") return "reference";
  if (top === "assets") return "asset";
  if (top === "scripts") return "script";
  return "other";
}

/** Whether a resource path looks like a text reference by extension. */
export function isTextReference(skillRelativePath: string): boolean {
  const lower = skillRelativePath.toLowerCase();
  for (const ext of TEXT_EXTENSIONS) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}

/** One regular file under a skill root, as a skill-relative POSIX path. */
export type SkillFileEntry = { path: string; bytes: number };

/**
 * Walk every regular file under a skill root as skill-relative POSIX paths,
 * rejecting symbolic links, devices, sockets, and unsafe path shapes. Bounds
 * the supporting-resource count (everything except `skillFileName`) to
 * `MAX_RESOURCES_PER_SKILL`; further entries stop the walk and surface one
 * `resource-count-oversize` diagnostic so the caller can refuse the skill
 * rather than storing a truncated snapshot.
 */
async function walkSkillFiles(
  rootDirectory: string,
  skillFileName = "SKILL.md",
): Promise<{ files: SkillFileEntry[]; diagnostics: SkillDiagnostic[] }> {
  const files: SkillFileEntry[] = [];
  const diagnostics: SkillDiagnostic[] = [];

  async function visit(directory: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      diagnostics.push({ kind: "read-error", message: readErrorMessage(error) });
      return;
    }
    for (const entry of entries) {
      await visitEntry(directory, entry);
    }
  }

  async function visitEntry(directory: string, entry: Dirent): Promise<void> {
    const absolutePath = join(directory, entry.name);
    const relativePath = relative(rootDirectory, absolutePath).split(sep).join("/");
    if (entry.isSymbolicLink()) {
      diagnostics.push({ kind: "resource-symlink", message: `Symbolic links are not supported: ${relativePath}.` });
      return;
    }
    if (entry.isFile()) {
      const isSkillFile = relativePath === skillFileName;
      const resourceCount = files.filter((file) => file.path !== skillFileName).length;
      if (!isSkillFile && resourceCount >= MAX_RESOURCES_PER_SKILL) {
        diagnostics.push({
          kind: "resource-count-oversize",
          message: `Skill exceeds the ${MAX_RESOURCES_PER_SKILL} resource limit; further entries are not indexed.`,
        });
        return;
      }
      let info: Stats;
      try {
        info = await lstat(absolutePath);
      } catch (error) {
        diagnostics.push({ kind: "read-error", message: `${relativePath}: ${readErrorMessage(error)}` });
        return;
      }
      // Race-aware re-check: reject a swap to a non-regular file between the
      // directory read and the lstat.
      if (info.isSymbolicLink() || !info.isFile()) {
        diagnostics.push({ kind: "resource-path-unsafe", message: `${relativePath} is not a regular file.` });
        return;
      }
      // Reject paths Phase 2's read_skill_resource would refuse (e.g. a POSIX
      // filename containing a backslash) so a snapshot is never installed with
      // an unreadable inventory. `assertSafeRelativePath` throws; surface it as
      // one `resource-path-unsafe` diagnostic and skip the file.
      try {
        assertSafeRelativePath(relativePath);
      } catch {
        diagnostics.push({ kind: "resource-path-unsafe", message: `${relativePath} is not a supported skill-relative path.` });
        return;
      }
      files.push({ path: relativePath, bytes: info.size });
    } else if (entry.isDirectory()) {
      await visit(absolutePath);
    } else {
      diagnostics.push({
        kind: "resource-path-unsafe",
        message: `Unsupported filesystem entry: ${relativePath}.`,
      });
    }
  }

  await visit(rootDirectory);
  files.sort((left, right) => left.path.localeCompare(right.path));
  return { files, diagnostics };
}

/**
 * Supporting resources for inspection: every regular file except the entry
 * `SKILL.md`, classified by the conventional directory, with oversized text
 * references flagged. Used by the loader to attach a resource manifest.
 */
export async function enumerateSkillResources(
  rootDirectory: string,
  skillFileName = "SKILL.md",
): Promise<{ resources: SkillResource[]; diagnostics: SkillDiagnostic[] }> {
  const { files, diagnostics } = await walkSkillFiles(rootDirectory, skillFileName);
  const resources: SkillResource[] = [];
  for (const file of files) {
    if (file.path === skillFileName) continue;
    const kind = classifyResource(file.path);
    if (kind === "reference" && isTextReference(file.path) && file.bytes > MAX_TEXT_REFERENCE_BYTES) {
      diagnostics.push({
        kind: "resource-oversized",
        message: `${file.path} exceeds the ${MAX_TEXT_REFERENCE_BYTES}-byte text reference limit.`,
      });
    }
    try {
      const raw = await readFile(join(rootDirectory, ...file.path.split("/")));
      resources.push({ path: file.path, kind, bytes: file.bytes, sha256: createHash("sha256").update(raw).digest("hex") });
    } catch (error) {
      diagnostics.push({ kind: "read-error", message: `${file.path}: ${readErrorMessage(error)}` });
    }
  }
  return { resources, diagnostics };
}

/**
 * Complete file inventory of a skill bundle (including the entry `SKILL.md`),
 * for content-addressed storage and bundle hashing. The same safety guards as
 * `enumerateSkillResources` apply; an inventory with a `resource-count-oversize`
 * diagnostic is incomplete and the caller must refuse to store it.
 */
export async function enumerateSkillBundle(
  rootDirectory: string,
  skillFileName = "SKILL.md",
): Promise<{ files: SkillFileEntry[]; diagnostics: SkillDiagnostic[] }> {
  return walkSkillFiles(rootDirectory, skillFileName);
}

function readErrorMessage(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof (error as { code: unknown }).code === "string") {
    return (error as { code: string }).code;
  }
  return "unknown read error";
}
