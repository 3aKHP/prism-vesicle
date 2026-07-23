import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { existsSync } from "node:fs";
import { writableProjectRoots } from "../artifacts/roots";

/**
 * `/init` runs host-side, so it scans the project directly rather than through
 * the model-visible guarded filesystem tools. The digest is a bounded, readable
 * summary of the writable roots (file tree plus short text-file heads) that the
 * init provider call turns into a `VESICLE.md`.
 */

const MAX_FILES_PER_ROOT = 60;
const MAX_DEPTH = 4;
const MAX_HEAD_BYTES = 240;
const MAX_TOTAL_DIGEST_BYTES = 8 * 1024;
const HEAD_FILE_MAX_BYTES = 6 * 1024;
const TEXT_EXTENSIONS = new Set([".md", ".yaml", ".yml", ".txt", ".json"]);

export async function scanProject(rootDir: string): Promise<string> {
  const lines: string[] = [];
  let bytes = 0;
  const push = (line: string): boolean => {
    const next = bytes + line.length + 1;
    if (next > MAX_TOTAL_DIGEST_BYTES) return false;
    lines.push(line);
    bytes = next;
    return true;
  };

  const vesiclePath = join(rootDir, "VESICLE.md");
  if (existsSync(vesiclePath)) {
    push("Note: a VESICLE.md already exists at the project root and will be replaced (the host backs up the previous version).");
  }

  for (const root of writableProjectRoots) {
    if (bytes >= MAX_TOTAL_DIGEST_BYTES) break;
    const rootPath = join(rootDir, root);
    const exists = await stat(rootPath).then((info) => info.isDirectory()).catch(() => false);
    if (!exists) continue;
    if (!push(`${root}/`)) break;
    const counted = await walkRoot(rootPath, rootDir, push);
    if (counted.skipped) push(`  …${counted.skipped} more file${counted.skipped === 1 ? "" : "s"} not shown`);
    push("");
  }

  return lines.join("\n").trim();
}

async function walkRoot(
  rootPath: string,
  rootDir: string,
  push: (line: string) => boolean,
): Promise<{ skipped: number }> {
  let fileCount = 0;
  let skipped = 0;
  const stack: Array<{ dir: string; depth: number }> = [{ dir: rootPath, depth: 0 }];
  while (stack.length > 0) {
    const { dir, depth } = stack.shift()!;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => undefined);
    if (!entries) continue;
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === ".gitkeep" || entry.name === ".vesicle") continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH) stack.push({ dir: fullPath, depth: depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      if (fileCount >= MAX_FILES_PER_ROOT) {
        skipped += 1;
        continue;
      }
      fileCount += 1;
      const rel = relative(rootDir, fullPath).replace(/\\/g, "/");
      const info = await stat(fullPath).catch(() => undefined);
      const sizeText = info ? formatBytes(info.size) : "?";
      const head = await readHead(fullPath);
      const line = head ? `  - ${rel} (${sizeText}) — "${head}"` : `  - ${rel} (${sizeText})`;
      if (!push(line)) return { skipped };
    }
  }
  return { skipped };
}

async function readHead(path: string): Promise<string | undefined> {
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
  if (!TEXT_EXTENSIONS.has(ext)) return undefined;
  const info = await stat(path).catch(() => undefined);
  if (!info || info.size > HEAD_FILE_MAX_BYTES) return undefined;
  const content = await readFile(path, "utf8").catch(() => undefined);
  if (content === undefined) return undefined;
  const collapsed = content.replace(/\s+/g, " ").trim();
  return collapsed.slice(0, MAX_HEAD_BYTES);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
