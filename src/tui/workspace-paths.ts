import { relative, resolve } from "node:path";

/**
 * Normalize a project-relative path and assert it stays inside the project
 * root. Rejects POSIX, UNC, and drive-letter absolute paths, NUL bytes, and
 * `..` traversal. Returns the resolved absolute path.
 */
export function assertProjectRelativePath(rootDir: string, relPath: string): string {
  if (!relPath || relPath.includes("\0")) throw new Error("Path is required.");
  const posix = relPath.replace(/\\/g, "/");
  if (posix.startsWith("/") || /^[A-Za-z]:/.test(posix)) {
    throw new Error("Only project-relative paths are allowed.");
  }
  const root = resolve(rootDir);
  const resolved = resolve(root, posix);
  const rel = relative(root, resolved);
  if (rel === "" || rel === ".." || rel.startsWith("..")) {
    throw new Error(`Path escapes project root: ${relPath}`);
  }
  return resolved;
}
