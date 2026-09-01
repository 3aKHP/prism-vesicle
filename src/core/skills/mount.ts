/**
 * Read-only logical mount of activated Skills (`skills/` namespace).
 *
 * The mount exposes the session's activated Skills to the ordinary read-only
 * file tools (stat_path / list_directory / grep_files / read_file /
 * view_image) behind the same resolver-injection shape as the `assets` root.
 * The mount set is exactly the activation registry: activating a Skill mounts
 * it, and rewind or compaction loss unmounts it, so activation remains the
 * single consent gate for Skill content.
 *
 * Paths are mount-logical (`skills`, `skills/<name>`, `skills/<name>/<rel>`)
 * and never expose the absolute host root. Enumeration (list/grep) follows the
 * frozen catalog inventory — `SKILL.md` plus `parsed.resources`, already
 * bounded by `MAX_RESOURCES_PER_SKILL` at load time — so files added under a
 * skill root after the catalog froze stay invisible until a new session.
 * Direct reads resolve the live root through the shared virtual-root
 * hardening (`resolveSkillFile`) exactly like `read_skill_resource`, and honor
 * the same 256 KiB text cap.
 */

import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { MAX_TEXT_REFERENCE_BYTES, utf8SafeBoundary } from "../../skills/paths";
import { getActivatedSkill } from "./activation-state";
import type { ResolvedSkillCatalog } from "./catalog";
import { resolveActiveSkill, resolveSkillFile } from "./tools/activated-skill";
import type { ValidSkill } from "./tools/activated-skill";

export type SkillMountStat = {
  type: "file" | "directory";
  size?: number;
  modifiedAt: Date;
};

export type SkillMountEntry = {
  /** Full mount-logical path, e.g. `skills/<name>/references/glossary.md`. */
  path: string;
  type: "file" | "directory";
  size?: number;
  modifiedAt: Date;
};

export type SkillMountListing = {
  entries: SkillMountEntry[];
  truncated: boolean;
  fileCount: number;
  directoryCount: number;
};

/** Normalize user-supplied separators to the mount's forward-slash grammar. */
export function normalizeSkillMountPath(requestedPath: string): string {
  return requestedPath.replaceAll("\\", "/");
}

type MountAddress = { name?: string; relPath?: string };

/** Split `skills[/<name>[/<rel>]]` into its segments; empty tails fold up. */
function parseMountPath(normalizedPath: string): MountAddress {
  const rest = normalizedPath === "skills" || normalizedPath === "skills/" ? "" : normalizedPath.slice("skills/".length);
  if (rest === "") return {};
  const slash = rest.indexOf("/");
  if (slash === -1) return { name: rest };
  const name = rest.slice(0, slash);
  const relPath = rest.slice(slash + 1);
  return relPath === "" ? { name } : { name, relPath };
}

/** Mounted file inventory (skill-relative), headed by the entry `SKILL.md`. */
function skillInventory(skill: ValidSkill): string[] {
  return ["SKILL.md", ...skill.parsed.resources.map((resource) => resource.path)];
}

export class SkillMount {
  constructor(
    private readonly catalog: ResolvedSkillCatalog,
    private readonly sessionId: string,
  ) {}

  /** Activated catalog winners in catalog order — the current mount set. */
  private activatedSkills(): ValidSkill[] {
    const skills: ValidSkill[] = [];
    for (const entry of this.catalog.catalog.entries) {
      if (!getActivatedSkill(this.sessionId, entry.name)) continue;
      const resolved = resolveActiveSkill(this.catalog, this.sessionId, entry.name);
      if ("skill" in resolved) skills.push(resolved.skill);
    }
    return skills;
  }

  /** Gate one skill by name; throws the shared instructive gate error. */
  private gate(name: string): ValidSkill {
    const resolved = resolveActiveSkill(this.catalog, this.sessionId, name);
    if ("error" in resolved) throw new Error(resolved.error);
    return resolved.skill;
  }

  async stat(logicalPath: string): Promise<SkillMountStat | undefined> {
    const { name, relPath } = parseMountPath(normalizeSkillMountPath(logicalPath));
    if (name === undefined) return { type: "directory", size: 0, modifiedAt: new Date(0) };
    const skill = this.gate(name);
    if (relPath === undefined) return statDirectory(skill.rootDirectory);
    // Direct reads/stats resolve the live root like read_skill_resource; only
    // intermediate directory observations derive from the frozen inventory.
    const resolved = await resolveSkillFile(skill, relPath);
    if ("error" in resolved) {
      return skillInventory(skill).some((path) => path.startsWith(`${relPath}/`))
        ? await statDirectory(join(skill.rootDirectory, ...relPath.split("/")))
        : undefined;
    }
    const info = await lstat(resolved.absolutePath).catch(() => undefined);
    return info?.isFile() ? { type: "file", size: info.size, modifiedAt: info.mtime } : undefined;
  }

  async listDirectory(
    logicalPath: string,
    options: { recursive?: boolean; filesOnly?: boolean } = {},
  ): Promise<SkillMountListing | undefined> {
    const { name, relPath } = parseMountPath(normalizeSkillMountPath(logicalPath));
    if (name === undefined) {
      const entries: SkillMountEntry[] = [];
      for (const skill of this.activatedSkills()) {
        const entry = await mountEntry(`skills/${skill.name}`, "directory", skill.rootDirectory);
        if (entry) entries.push(entry);
      }
      return { entries, truncated: false, fileCount: 0, directoryCount: entries.length };
    }
    const skill = this.gate(name);
    const prefix = relPath ?? "";
    const inventory = skillInventory(skill);
    const descendants = prefix === ""
      ? inventory
      : inventory.filter((path) => path.startsWith(`${prefix}/`));
    if (prefix !== "" && descendants.length === 0) return undefined;

    const directoryPaths = new Set<string>();
    const filePaths: string[] = [];
    for (const path of descendants) {
      const rest = prefix === "" ? path : path.slice(prefix.length + 1);
      const slash = rest.indexOf("/");
      if (slash === -1) {
        filePaths.push(path);
      } else {
        directoryPaths.add(rest.slice(0, slash));
        if (options.recursive) {
          let index = rest.indexOf("/", slash + 1);
          while (index !== -1) {
            directoryPaths.add(rest.slice(0, index));
            index = rest.indexOf("/", index + 1);
          }
        }
      }
    }

    const entries: SkillMountEntry[] = [];
    if (!options.filesOnly) {
      for (const dirPath of [...directoryPaths].sort()) {
        const entry = await mountEntry(`skills/${name}/${dirPath}`, "directory", join(skill.rootDirectory, ...dirPath.split("/")));
        if (entry) entries.push(entry);
      }
    }
    for (const filePath of filePaths.sort()) {
      const entry = await mountEntry(`skills/${name}/${filePath}`, "file", join(skill.rootDirectory, ...filePath.split("/")));
      if (entry) entries.push(entry);
    }
    // Directories and files interleave by path so listing order is one
    // deterministic sequence, mirroring ordinary directory observations.
    entries.sort((left, right) => left.path.localeCompare(right.path));
    const fileCount = entries.filter((entry) => entry.type === "file").length;
    return {
      entries,
      truncated: false,
      fileCount,
      directoryCount: entries.length - fileCount,
    };
  }

  /** Text files searchable under a prefix, as full mount-logical paths. */
  async grepFiles(prefix: string, recursive: boolean): Promise<{ files: string[]; notes: string[] }> {
    const normalized = normalizeSkillMountPath(prefix);
    const { name, relPath } = parseMountPath(normalized);
    const skills = name === undefined ? this.activatedSkills() : [this.gate(name)];

    const files: string[] = [];
    const notes: string[] = [];
    for (const skill of skills) {
      const inventory = skillInventory(skill);
      let matches: string[];
      if (relPath !== undefined && inventory.includes(relPath)) {
        matches = [relPath];
      } else {
        const scoped = relPath === undefined ? inventory : inventory.filter((path) => path.startsWith(`${relPath}/`));
        if (relPath !== undefined && scoped.length === 0) {
          throw new Error(`"${normalized}" is not a mounted Skill file or directory.`);
        }
        // Non-recursive directory scopes match only immediate file children,
        // mirroring grep_files over an ordinary directory.
        const base = relPath === undefined ? "" : `${relPath}/`;
        matches = recursive
          ? scoped
          : scoped.filter((path) => !path.slice(base.length).includes("/"));
      }
      for (const path of matches) {
        if (resourceBytes(skill, path) > MAX_TEXT_REFERENCE_BYTES) {
          notes.push(`skipped ${`skills/${skill.name}/${path}`} (exceeds the ${MAX_TEXT_REFERENCE_BYTES}-byte text limit)`);
        } else {
          files.push(`skills/${skill.name}/${path}`);
        }
      }
    }
    return { files, notes };
  }

  /** Read one mounted file with the 256 KiB cap shared with read_skill_resource. */
  async readText(logicalPath: string): Promise<{ text: string; bytes: number; truncated: boolean; note?: string }> {
    const file = await this.resolveFile(logicalPath);
    const raw = await readFile(file.absolutePath);
    const capped = raw.byteLength > MAX_TEXT_REFERENCE_BYTES;
    const kept = capped ? raw.subarray(0, utf8SafeBoundary(raw, MAX_TEXT_REFERENCE_BYTES)) : raw;
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(kept);
    } catch {
      throw new Error(
        `Skill resource "${file.relPath}" is not valid UTF-8 text and cannot be read through the skills mount. Binary assets are disclosed by activate_skill; view images with view_image.`,
      );
    }
    return {
      text,
      bytes: raw.byteLength,
      truncated: capped,
      ...(capped ? { note: `[truncated: resource exceeds the ${MAX_TEXT_REFERENCE_BYTES}-byte text limit; only the first part is shown]` } : {}),
    };
  }

  async readBytes(logicalPath: string): Promise<Uint8Array> {
    const file = await this.resolveFile(logicalPath);
    return readFile(file.absolutePath);
  }

  /**
   * Uncapped, lossy UTF-8 read for grep scanning: mirrors `grep_files` over
   * project files. Oversized files never reach this path (`grepFiles` skips
   * them by manifest bytes), and match excerpts stay bounded by the shared
   * grep output caps.
   */
  async grepReadText(logicalPath: string): Promise<string> {
    const file = await this.resolveFile(logicalPath);
    return readFile(file.absolutePath, "utf8");
  }

  private async resolveFile(logicalPath: string): Promise<{ skill: ValidSkill; relPath: string; absolutePath: string }> {
    const { name, relPath } = parseMountPath(normalizeSkillMountPath(logicalPath));
    if (name === undefined || relPath === undefined) {
      throw new Error(`"${logicalPath}" names the skills mount root, not a Skill file.`);
    }
    const skill = this.gate(name);
    const resolved = await resolveSkillFile(skill, relPath);
    if ("error" in resolved) throw new Error(resolved.error);
    return { skill, relPath, absolutePath: resolved.absolutePath };
  }
}

async function statDirectory(absolutePath: string): Promise<SkillMountStat | undefined> {
  const info = await lstat(absolutePath).catch(() => undefined);
  return info?.isDirectory() ? { type: "directory", size: info.size, modifiedAt: info.mtime } : undefined;
}

async function mountEntry(path: string, type: "file" | "directory", absolutePath: string): Promise<SkillMountEntry | undefined> {
  // Inventory entries that vanished from disk since the catalog froze are
  // omitted rather than reported with fabricated metadata.
  const info = await lstat(absolutePath).catch(() => undefined);
  if (!info) return undefined;
  return { path, type, size: info.size, modifiedAt: info.mtime };
}

/** Manifest bytes when known; lstat size for the entry `SKILL.md`. */
function resourceBytes(skill: ValidSkill, path: string): number {
  if (path === "SKILL.md") return skill.parsed.bytes;
  return skill.parsed.resources.find((resource) => resource.path === path)?.bytes ?? Number.POSITIVE_INFINITY;
}
