import { lstat, readdir, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { normalizeAssetPath, type AssetResolver } from "../../runtime/assets";
import { isEnoent, toProjectPath } from "./path-policy";

export function sliceLines(content: string, startLine: number | undefined, endLine: number | undefined): string {
  if (startLine === undefined && endLine === undefined) return content;
  const start = startLine ?? 1;
  const end = endLine ?? Number.POSITIVE_INFINITY;
  if (typeof start !== "number") throw new Error("startLine must be a number.");
  if (typeof end !== "number") throw new Error("endLine must be a number.");
  if (!Number.isInteger(start) || start <= 0) throw new Error("startLine must be a positive integer.");
  if (!Number.isInteger(end) && end !== Number.POSITIVE_INFINITY) throw new Error("endLine must be a positive integer.");
  if (end < start) throw new Error("endLine must be greater than or equal to startLine.");
  return content.split(/\r?\n/).slice(start - 1, end).join("\n");
}

export async function grepFiles(
  rootDir: string,
  targetPath: string,
  args: { pattern: string; regex?: boolean; caseSensitive?: boolean; recursive?: boolean; maxMatches?: number },
): Promise<{ matches: Array<{ path: string; line: number; text: string }>; truncated: boolean }> {
  if (!args.pattern) throw new Error("pattern must not be empty.");
  const limit = clampPositiveInteger(args.maxMatches ?? 50, "maxMatches", 200);
  const matcher = createMatcher(args.pattern, Boolean(args.regex), Boolean(args.caseSensitive));
  const info = await stat(targetPath);
  const files = info.isFile()
    ? [targetPath]
    : info.isDirectory()
      ? await listFiles(targetPath, args.recursive ?? true)
      : [];
  const matches: Array<{ path: string; line: number; text: string }> = [];

  for (const file of files) {
    const lines = (await readFile(file, "utf8")).split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      if (!matcher(lines[index])) continue;
      matches.push({ path: toProjectPath(rootDir, file), line: index + 1, text: lines[index] });
      if (matches.length >= limit) return { matches, truncated: true };
    }
  }

  return { matches, truncated: false };
}

export async function grepAssetFiles(
  assets: AssetResolver,
  requestedPath: string,
  args: { pattern: string; regex?: boolean; caseSensitive?: boolean; recursive?: boolean; maxMatches?: number },
): Promise<{ matches: Array<{ path: string; line: number; text: string }>; truncated: boolean }> {
  if (!args.pattern) throw new Error("pattern must not be empty.");
  const limit = clampPositiveInteger(args.maxMatches ?? 50, "maxMatches", 200);
  const matcher = createMatcher(args.pattern, Boolean(args.regex), Boolean(args.caseSensitive));
  const logicalPath = normalizeAssetPath(requestedPath, { allowRoot: true });
  const info = await assets.stat(logicalPath);
  const files = info.type === "file"
    ? [logicalPath]
    : await assets.listFiles(logicalPath, args.recursive ?? true);
  const matches: Array<{ path: string; line: number; text: string }> = [];

  for (const file of files) {
    const lines = (await assets.readText(file)).split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      if (!matcher(lines[index])) continue;
      matches.push({ path: file, line: index + 1, text: lines[index] });
      if (matches.length >= limit) return { matches, truncated: true };
    }
  }
  return { matches, truncated: false };
}

function createMatcher(pattern: string, regex: boolean, caseSensitive: boolean): (line: string) => boolean {
  if (regex) {
    // Regex patterns are model-provided but currently trusted inside the
    // single-user TUI. If Vesicle exposes untrusted providers, move regex
    // matching behind a timeout-capable engine such as RE2 or a worker.
    const expression = new RegExp(pattern, caseSensitive ? "" : "i");
    return (line) => expression.test(line);
  }
  const needle = caseSensitive ? pattern : pattern.toLocaleLowerCase();
  return (line) => (caseSensitive ? line : line.toLocaleLowerCase()).includes(needle);
}

function clampPositiveInteger(value: number, name: string, max: number): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
  return Math.min(value, max);
}

export async function listFiles(dir: string, recursive: boolean): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  });
  const result: string[] = [];

  for (const entry of entries) {
    const fullPath = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (recursive) {
        result.push(...await listFiles(fullPath, true));
      }
      continue;
    }

    if (entry.isFile()) {
      result.push(fullPath);
      continue;
    }

    // Symbolic links and other special entries are deliberately not followed.
  }

  return result.sort();
}

type DirectoryEntry = {
  path: string;
  type: "file" | "directory" | "symlink" | "other";
  size?: number;
  modifiedAt: string;
};

export async function listDirectoryEntries(
  rootDir: string,
  directoryPath: string,
  recursive: boolean,
): Promise<{ entries: DirectoryEntry[]; truncated: boolean }> {
  const limit = 500;
  const entries: DirectoryEntry[] = [];
  let truncated = false;

  const visit = async (dir: string): Promise<void> => {
    for (const child of await readdir(dir, { withFileTypes: true })) {
      if (entries.length >= limit) {
        truncated = true;
        return;
      }
      const fullPath = resolve(dir, child.name);
      const info = await lstat(fullPath);
      const type = info.isSymbolicLink()
        ? "symlink"
        : info.isDirectory()
          ? "directory"
          : info.isFile()
            ? "file"
            : "other";
      entries.push({
        path: toProjectPath(rootDir, fullPath),
        type,
        ...(type === "file" ? { size: info.size } : {}),
        modifiedAt: info.mtime.toISOString(),
      });
      if (recursive && type === "directory") await visit(fullPath);
      if (truncated) return;
    }
  };

  await visit(directoryPath);
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return { entries, truncated };
}
