import { lstat, open, readdir, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { normalizeAssetPath, type AssetResolver } from "../../runtime/assets";
import { toProjectPath } from "./path-policy";

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

/** Cap a single grep match line so one giant (e.g. minified) line cannot fill the result. */
const maxGrepExcerptChars = 500;
function capGrepExcerpt(line: string): string {
  return line.length > maxGrepExcerptChars ? `${line.slice(0, maxGrepExcerptChars)} … [truncated, ${line.length} chars]` : line;
}

/**
 * Read a bounded UTF-8 byte slice of a file without loading the whole file
 * (#137B): used for large persisted MCP outputs. `offsetBytes`/`maxBytes` are
 * validated here. The slice may split a multi-byte character at its end; the
 * caller can shift the offset to recover it.
 */
export async function readByteSlice(
  filePath: string,
  offsetBytes: number,
  maxBytes: number,
): Promise<{ content: string; totalBytes: number; bytes: number; truncated: boolean }> {
  if (!Number.isInteger(offsetBytes) || offsetBytes < 0) throw new Error("offsetBytes must be a non-negative integer.");
  const cap = clampPositiveInteger(maxBytes, "maxBytes", 1024 * 1024);
  const handle = await open(filePath, "r");
  try {
    const totalBytes = (await handle.stat()).size;
    const start = Math.min(offsetBytes, totalBytes);
    const length = Math.max(0, Math.min(cap, totalBytes - start));
    const buffer = Buffer.alloc(length);
    // Use the actual bytes read: a short read (e.g. concurrent truncation) must
    // not leave a zero-filled tail that would inject NULs into the result.
    const { bytesRead } = length > 0 ? await handle.read(buffer, 0, length, start) : { bytesRead: 0 };
    return {
      content: buffer.subarray(0, bytesRead).toString("utf8"),
      totalBytes,
      bytes: bytesRead,
      truncated: start + bytesRead < totalBytes,
    };
  } finally {
    await handle.close();
  }
}

export type GrepOutputMode = "content" | "files_with_matches" | "count";

export type GrepContextLine = { line: number; text: string };

export type GrepContentMatch = {
  path: string;
  line: number;
  text: string;
  before?: GrepContextLine[];
  after?: GrepContextLine[];
};

export type GrepResult =
  | { outputMode: "content"; matches: GrepContentMatch[]; truncated: boolean }
  | { outputMode: "files_with_matches"; files: string[]; truncated: boolean }
  | { outputMode: "count"; counts: Array<{ path: string; matches: number }>; totalMatches: number; truncated: boolean };

type GrepArgs = {
  pattern: string;
  regex?: boolean;
  caseSensitive?: boolean;
  recursive?: boolean;
  maxMatches?: number;
  contextLines?: number;
  outputMode?: GrepOutputMode;
};

const maxContextLines = 10;

/** Host-side safety valve on total grep output text (~8K tokens). */
const maxGrepResultChars = 32768;

type GrepScanInput = {
  files: string[];
  readText: (file: string) => Promise<string>;
  toResultPath: (file: string) => string;
};

/** Split into lines and strip the trailing empty element produced by a terminal newline. */
function normalizeLines(content: string): string[] {
  const lines = content.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

async function executeGrepScan(
  input: GrepScanInput,
  args: { matcher: (line: string) => boolean; limit: number; contextLines: number; outputMode: GrepOutputMode },
): Promise<GrepResult> {
  const { matcher, limit, contextLines, outputMode } = args;

  if (outputMode === "files_with_matches") {
    const files: string[] = [];
    for (const file of input.files) {
      const lines = normalizeLines(await input.readText(file));
      for (let index = 0; index < lines.length; index++) {
        if (!matcher(lines[index]!)) continue;
        files.push(input.toResultPath(file));
        break; // first match in this file is enough
      }
      if (files.length >= limit) return { outputMode: "files_with_matches", files, truncated: true };
    }
    return { outputMode: "files_with_matches", files, truncated: false };
  }

  if (outputMode === "count") {
    const counts: Array<{ path: string; matches: number }> = [];
    let totalMatches = 0;
    for (const file of input.files) {
      const lines = normalizeLines(await input.readText(file));
      let fileCount = 0;
      for (let index = 0; index < lines.length; index++) {
        if (matcher(lines[index]!)) fileCount++;
      }
      if (fileCount > 0) {
        counts.push({ path: input.toResultPath(file), matches: fileCount });
        totalMatches += fileCount;
      }
      if (counts.length >= limit) return { outputMode: "count", counts, totalMatches, truncated: true };
    }
    return { outputMode: "count", counts, totalMatches, truncated: false };
  }

  // content mode
  const matches: GrepContentMatch[] = [];
  let outputChars = 0;
  for (const file of input.files) {
    const lines = normalizeLines(await input.readText(file));
    for (let index = 0; index < lines.length; index++) {
      if (!matcher(lines[index]!)) continue;
      const text = capGrepExcerpt(lines[index]!);
      const entry: GrepContentMatch = {
        path: input.toResultPath(file),
        line: index + 1,
        text,
      };
      outputChars += text.length;
      if (contextLines > 0) {
        entry.before = collectContextLines(lines, index, contextLines, "before");
        entry.after = collectContextLines(lines, index, contextLines, "after");
        outputChars += entry.before.reduce((sum, c) => sum + c.text.length, 0)
          + entry.after.reduce((sum, c) => sum + c.text.length, 0);
      }
      matches.push(entry);
      if (matches.length >= limit || outputChars >= maxGrepResultChars) {
        return { outputMode: "content", matches, truncated: true };
      }
    }
  }
  return { outputMode: "content", matches, truncated: false };
}

function collectContextLines(
  lines: string[],
  matchIndex: number,
  count: number,
  direction: "before" | "after",
): GrepContextLine[] {
  const result: GrepContextLine[] = [];
  if (direction === "before") {
    const start = Math.max(0, matchIndex - count);
    for (let i = start; i < matchIndex; i++) {
      result.push({ line: i + 1, text: capGrepExcerpt(lines[i]!) });
    }
  } else {
    const end = Math.min(lines.length - 1, matchIndex + count);
    for (let i = matchIndex + 1; i <= end; i++) {
      result.push({ line: i + 1, text: capGrepExcerpt(lines[i]!) });
    }
  }
  return result;
}

function clampContextLines(value: number | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isInteger(value) || value < 0) throw new Error("contextLines must be a non-negative integer.");
  return Math.min(value, maxContextLines);
}

function validateOutputMode(value: GrepOutputMode | undefined): GrepOutputMode {
  if (value === undefined) return "content";
  if (value === "content" || value === "files_with_matches" || value === "count") return value;
  throw new Error("outputMode must be one of: content, files_with_matches, count.");
}

export async function grepFiles(
  rootDir: string,
  targetPath: string,
  args: GrepArgs,
): Promise<GrepResult> {
  if (!args.pattern) throw new Error("pattern must not be empty.");
  const limit = clampPositiveInteger(args.maxMatches ?? 50, "maxMatches", 200);
  const matcher = createMatcher(args.pattern, Boolean(args.regex), Boolean(args.caseSensitive));
  const info = await stat(targetPath);
  const files = info.isFile()
    ? [targetPath]
    : info.isDirectory()
      ? await listFiles(targetPath, args.recursive ?? true)
      : [];
  return executeGrepScan(
    {
      files,
      readText: (file) => readFile(file, "utf8"),
      toResultPath: (file) => toProjectPath(rootDir, file),
    },
    { matcher, limit, contextLines: clampContextLines(args.contextLines), outputMode: validateOutputMode(args.outputMode) },
  );
}

export async function grepAssetFiles(
  assets: AssetResolver,
  requestedPath: string,
  args: GrepArgs,
): Promise<GrepResult> {
  if (!args.pattern) throw new Error("pattern must not be empty.");
  const limit = clampPositiveInteger(args.maxMatches ?? 50, "maxMatches", 200);
  const matcher = createMatcher(args.pattern, Boolean(args.regex), Boolean(args.caseSensitive));
  const logicalPath = normalizeAssetPath(requestedPath, { allowRoot: true });
  const info = await assets.stat(logicalPath);
  const files = info.type === "file"
    ? [logicalPath]
    : await assets.listFiles(logicalPath, args.recursive ?? true);
  return executeGrepScan(
    {
      files,
      readText: (file) => assets.readText(file),
      toResultPath: (file) => file,
    },
    { matcher, limit, contextLines: clampContextLines(args.contextLines), outputMode: validateOutputMode(args.outputMode) },
  );
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
