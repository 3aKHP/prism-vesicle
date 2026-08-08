import { constants, type Dirent, type Stats } from "node:fs";
import { access, lstat, open, readFile, readdir } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";
import { assertProjectRelativePath } from "./paths";

/**
 * Filesystem model for the Workspace page (Scope B / #62, milestone B2).
 * Read-only: directory scanning, file classification, fuzzy file matching,
 * and bounded text preview reads. No writes live here — the editor (B3) and
 * file management (B4) get their own modules with explicit guards.
 *
 * Scope rules: the tree roots at the project directory. Hidden by default
 * are dotfiles and a fixed noisy-entry list (.git, .vesicle, node_modules,
 * dist); `.` toggles them. Symlinks, read-only files, and oversized files
 * are flagged, never followed or loaded blindly.
 */

export type WorkspaceFileKind = "markdown" | "text" | "image" | "binary";

export type WorkspaceTreeNode = {
  name: string;
  /** Project-relative path (posix-style separators). */
  relPath: string;
  kind: "dir" | "file";
  fileKind?: WorkspaceFileKind;
  symlink?: boolean;
  readonly?: boolean;
  size?: number;
  /** undefined = not yet scanned (lazy); present once scanned. */
  children?: WorkspaceTreeNode[];
};

/** One flattened row of the visible tree for rendering and keyboard nav. */
export type WorkspaceVisibleRow = {
  node: WorkspaceTreeNode;
  depth: number;
  expanded: boolean;
};

const HIDDEN_ENTRY_NAMES = new Set([".git", ".vesicle", "node_modules", "dist"]);

const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown", ".mdx"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp"]);
const TEXT_EXTENSIONS = new Set([
  ".txt", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".jsonl",
  ".yaml", ".yml", ".toml", ".xml", ".html", ".htm", ".css", ".svg",
  ".py", ".sh", ".bash", ".zsh", ".ps1", ".iss", ".sql", ".csv", ".tsv",
  ".lock", ".log", ".diff", ".patch", ".cfg", ".ini", ".conf",
  ".gitignore", ".gitattributes", ".editorconfig", ".env.example",
]);

/** Files above this size are flagged oversized; text previews truncate. */
export const OVERSIZED_BYTES = 512 * 1024;
/** Text previews cap at this many lines regardless of file size. */
export const PREVIEW_LINE_CAP = 2000;

function extensionOf(name: string): string {
  return extname(name).toLowerCase();
}

export function classifyFile(name: string): WorkspaceFileKind {
  const ext = extensionOf(name);
  if (MARKDOWN_EXTENSIONS.has(ext)) return "markdown";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (TEXT_EXTENSIONS.has(ext)) return "text";
  // Extensionless regular files (LICENSE, Makefile, …) are treated as text;
  // genuinely binary data is caught by the NUL sniff in readFilePreview.
  if (ext === "") return "text";
  return "binary";
}

function isHiddenName(name: string): boolean {
  return name.startsWith(".") || HIDDEN_ENTRY_NAMES.has(name);
}

function sortNodes(nodes: WorkspaceTreeNode[]): WorkspaceTreeNode[] {
  return nodes.sort((a, b) =>
    a.kind !== b.kind ? (a.kind === "dir" ? -1 : 1) : a.name.localeCompare(b.name)
  );
}

async function nodeFor(rootDir: string, absPath: string, name: string): Promise<WorkspaceTreeNode | null> {
  let stats: Stats;
  try {
    stats = await lstat(absPath);
  } catch {
    return null; // vanished between readdir and lstat
  }
  const relPath = relative(rootDir, absPath).split("\\").join("/");
  const symlink = stats.isSymbolicLink();
  let readonly = symlink;
  if (!symlink) {
    try {
      await access(absPath, constants.W_OK);
    } catch {
      readonly = true;
    }
  }
  if (stats.isDirectory() && !symlink) {
    return { name, relPath, kind: "dir", symlink, readonly };
  }
  return {
    name,
    relPath,
    kind: "file",
    fileKind: classifyFile(name),
    symlink,
    readonly,
    size: stats.size,
  };
}

/** Scan one directory level. Children of subdirectories stay lazy. */
export async function scanDirectory(
  rootDir: string,
  relDir: string,
  options: { showHidden: boolean },
): Promise<WorkspaceTreeNode[]> {
  const absDir = relDir ? join(rootDir, relDir) : rootDir;
  let names: string[];
  try {
    names = await readdir(absDir);
  } catch {
    return [];
  }
  const nodes: WorkspaceTreeNode[] = [];
  for (const name of names) {
    if (!options.showHidden && isHiddenName(name)) continue;
    const node = await nodeFor(rootDir, join(absDir, name), name);
    if (node) nodes.push(node);
  }
  return sortNodes(nodes);
}

/**
 * Flatten the tree honouring the expanded-path set. Lazily scans a directory
 * the first time it appears expanded; `cache` memoises one level per path
 * until the caller clears it on refresh.
 */
export async function flattenVisibleTree(
  rootDir: string,
  expanded: ReadonlySet<string>,
  options: { showHidden: boolean },
  cache: Map<string, WorkspaceTreeNode[]>,
): Promise<WorkspaceVisibleRow[]> {
  async function childrenOf(relDir: string): Promise<WorkspaceTreeNode[]> {
    const cached = cache.get(relDir);
    if (cached) return cached;
    const scanned = await scanDirectory(rootDir, relDir, options);
    cache.set(relDir, scanned);
    return scanned;
  }
  const rows: WorkspaceVisibleRow[] = [];
  async function walk(relDir: string, depth: number): Promise<void> {
    for (const node of await childrenOf(relDir)) {
      const isExpanded = node.kind === "dir" && expanded.has(node.relPath);
      rows.push({ node, depth, expanded: isExpanded });
      if (isExpanded) await walk(node.relPath, depth + 1);
    }
  }
  await walk("", 0);
  return rows;
}

/**
 * Recursively index every visible file path (for quick-open and filter).
 * Hidden directories are skipped entirely, so the walk stays cheap.
 */
export async function buildFileIndex(
  rootDir: string,
  options: { showHidden: boolean },
): Promise<string[]> {
  const files: string[] = [];
  async function walk(absDir: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!options.showHidden && isHiddenName(entry.name)) continue;
      const abs = join(absDir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        files.push(relative(rootDir, abs).split("\\").join("/"));
      }
    }
  }
  await walk(rootDir);
  return files.sort();
}

/**
 * Subsequence fuzzy match over indexed paths. Scores basename-prefix and
 * contiguous hits higher; returns paths best-first, capped.
 */
export function matchFiles(index: readonly string[], query: string, cap = 50): string[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...index].slice(0, cap);
  const scored: { path: string; score: number }[] = [];
  for (const path of index) {
    const hay = path.toLowerCase();
    let cursor = 0;
    let score = 0;
    let run = 0;
    let matched = true;
    for (const ch of needle) {
      const hit = hay.indexOf(ch, cursor);
      if (hit < 0) { matched = false; break; }
      run = hit === cursor ? run + 1 : 0;
      score += 1 + run * 2;
      cursor = hit + 1;
    }
    if (!matched) continue;
    const base = basename(hay);
    if (base.startsWith(needle)) score += 30;
    else if (hay.includes(needle)) score += 12;
    score -= path.length * 0.01;
    scored.push({ path, score });
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, cap)
    .map((entry) => entry.path);
}

export type WorkspaceFilePreview = {
  kind: WorkspaceFileKind;
  relPath: string;
  size: number;
  readonly: boolean;
  symlink: boolean;
  oversized: boolean;
  /** Present for markdown/text previews; capped at PREVIEW_LINE_CAP lines. */
  lines?: string[];
  truncated?: boolean;
};

/** Read a bounded text preview, or metadata only for image/binary files. */
export async function readFilePreview(
  rootDir: string,
  relPath: string,
): Promise<WorkspaceFilePreview | null> {
  let abs: string;
  try {
    abs = assertProjectRelativePath(rootDir, relPath);
  } catch {
    return null;
  }
  let stats: Stats;
  try {
    stats = await lstat(abs);
  } catch {
    return null;
  }
  if (!stats.isFile() && !stats.isSymbolicLink()) return null;
  const kind = classifyFile(basename(relPath));
  const symlink = stats.isSymbolicLink();
  let readonly = symlink;
  if (!symlink) {
    try {
      await access(abs, constants.W_OK);
    } catch {
      readonly = true;
    }
  }
  const base: WorkspaceFilePreview = {
    kind,
    relPath,
    size: stats.size,
    readonly,
    symlink,
    oversized: stats.size > OVERSIZED_BYTES,
  };
  // A symlink is useful tree/viewer metadata, but previewing its bytes would
  // follow a potentially project-external target. Keep it metadata-only.
  if (symlink || kind === "image" || kind === "binary") return base;

  let content: Buffer;
  try {
    if (stats.size > OVERSIZED_BYTES) {
      // Bound the read so an oversized file never fills memory — the preview
      // is truncated to PREVIEW_LINE_CAP lines regardless, so the first
      // OVERSIZED_BYTES is always enough.
      const handle = await open(abs, "r");
      try {
        const buf = Buffer.alloc(OVERSIZED_BYTES);
        const { bytesRead } = await handle.read(buf, 0, OVERSIZED_BYTES, 0);
        content = buf.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
    } else {
      content = await readFile(abs);
    }
  } catch {
    return null;
  }
  // NUL sniff: extension said text but the bytes disagree.
  if (content.subarray(0, 4096).includes(0)) {
    return { ...base, kind: "binary", lines: undefined };
  }
  const text = content.toString("utf-8");
  const allLines = text.split("\n");
  const truncated = allLines.length > PREVIEW_LINE_CAP || stats.size > OVERSIZED_BYTES;
  return {
    ...base,
    lines: truncated ? allLines.slice(0, PREVIEW_LINE_CAP) : allLines,
    truncated,
  };
}

/** Classify a project-relative path for locate/open routing. */
export async function statEntry(
  rootDir: string,
  relPath: string,
): Promise<{ kind: "dir" | "file" } | null> {
  try {
    const stats = await lstat(assertProjectRelativePath(rootDir, relPath));
    if (stats.isDirectory()) return { kind: "dir" };
    if (stats.isFile() || stats.isSymbolicLink()) return { kind: "file" };
    return null;
  } catch {
    return null;
  }
}
