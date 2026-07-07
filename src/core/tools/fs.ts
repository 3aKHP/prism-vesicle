import { appendFile, copyFile, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

export type ToolCall = {
  id: string;
  name: string;
  arguments: string;
};

export type ToolResult = {
  callId: string;
  name: string;
  ok: boolean;
  content: string;
};

export type ToolDefinition = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

const readableRoots = ["assets", "source_materials", "workspace", "test_runs", "novels", "reports"];
const writableRoots = ["workspace", "test_runs", "novels", "reports"];

export const fileToolDefinitions: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "stat_path",
      description: "Inspect an allowed project-relative file or directory path.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Project-relative path under an allowed read root.",
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List files under an allowed Vesicle project directory.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Project-relative directory path, such as source_materials or workspace.",
          },
          recursive: {
            type: "boolean",
            description: "Whether to list files recursively. Defaults to false.",
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep_files",
      description: "Search allowed UTF-8 project files for literal text or a JavaScript regular expression.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Project-relative file or directory path under an allowed read root.",
          },
          pattern: {
            type: "string",
            description: "Search pattern. Interpreted literally unless regex is true.",
          },
          regex: {
            type: "boolean",
            description: "Treat pattern as a JavaScript regular expression. Defaults to false.",
          },
          caseSensitive: {
            type: "boolean",
            description: "Whether matching is case-sensitive. Defaults to false.",
          },
          recursive: {
            type: "boolean",
            description: "Whether to search directories recursively. Defaults to true.",
          },
          maxMatches: {
            type: "number",
            description: "Maximum matches to return. Defaults to 50 and is capped at 200.",
          },
        },
        required: ["path", "pattern"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a UTF-8 text file from an allowed Vesicle project directory.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Project-relative file path.",
          },
          startLine: {
            type: "number",
            description: "Optional 1-based first line to read.",
          },
          endLine: {
            type: "number",
            description: "Optional 1-based last line to read, inclusive.",
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_file",
      description: "Create a new UTF-8 artifact file. Fails if the file already exists.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Project-relative output path under workspace, test_runs, novels, or reports.",
          },
          content: {
            type: "string",
            description: "Full UTF-8 file content to write.",
          },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create or overwrite a UTF-8 artifact file under workspace, test_runs, novels, or reports.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Project-relative output path, such as workspace/luotianyi.md.",
          },
          content: {
            type: "string",
            description: "Full UTF-8 file content to write.",
          },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "replace_in_file",
      description: "Replace exact text inside an existing UTF-8 artifact file.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Project-relative file path under workspace, test_runs, novels, or reports.",
          },
          oldText: {
            type: "string",
            description: "Exact text to replace.",
          },
          newText: {
            type: "string",
            description: "Replacement text.",
          },
          replaceAll: {
            type: "boolean",
            description: "Replace every occurrence. Defaults to false; without it, exactly one occurrence must match.",
          },
        },
        required: ["path", "oldText", "newText"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "append_file",
      description: "Append UTF-8 text to an existing artifact file.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Project-relative file path under workspace, test_runs, novels, or reports.",
          },
          content: {
            type: "string",
            description: "UTF-8 content to append.",
          },
          createIfMissing: {
            type: "boolean",
            description: "Create the file if it does not exist. Defaults to false.",
          },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_file",
      description: "Delete a single artifact file. Directories are not deleted.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Project-relative file path under workspace, test_runs, novels, or reports.",
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "copy_file",
      description: "Copy an allowed file to an artifact root.",
      parameters: {
        type: "object",
        properties: {
          sourcePath: {
            type: "string",
            description: "Project-relative source file path under an allowed read root.",
          },
          targetPath: {
            type: "string",
            description: "Project-relative target path under workspace, test_runs, novels, or reports.",
          },
          overwrite: {
            type: "boolean",
            description: "Overwrite an existing target file. Defaults to false.",
          },
        },
        required: ["sourcePath", "targetPath"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "move_file",
      description: "Move or rename an artifact file inside artifact roots.",
      parameters: {
        type: "object",
        properties: {
          sourcePath: {
            type: "string",
            description: "Project-relative source file path under workspace, test_runs, novels, or reports.",
          },
          targetPath: {
            type: "string",
            description: "Project-relative target path under workspace, test_runs, novels, or reports.",
          },
          overwrite: {
            type: "boolean",
            description: "Overwrite an existing target file. Defaults to false.",
          },
        },
        required: ["sourcePath", "targetPath"],
        additionalProperties: false,
      },
    },
  },
];

export async function executeFileTool(rootDir: string, call: ToolCall): Promise<ToolResult> {
  try {
    switch (call.name) {
      case "stat_path": {
        const args = parseArgs<{ path: string }>(call.arguments);
        const resolved = resolveAllowed(rootDir, args.path, readableRoots);
        const info = await stat(resolved);
        return ok(call, JSON.stringify({
          path: toProjectPath(rootDir, resolved),
          type: info.isDirectory() ? "directory" : info.isFile() ? "file" : "other",
          size: info.size,
          modifiedAt: info.mtime.toISOString(),
        }));
      }

      case "list_files": {
        const args = parseArgs<{ path: string; recursive?: boolean }>(call.arguments);
        const dir = resolveAllowed(rootDir, args.path, readableRoots);
        const entries = await listFiles(dir, Boolean(args.recursive));
        return ok(call, entries.map((entry) => toProjectPath(rootDir, entry)).join("\n") || "(empty)");
      }

      case "grep_files": {
        const args = parseArgs<{
          path: string;
          pattern: string;
          regex?: boolean;
          caseSensitive?: boolean;
          recursive?: boolean;
          maxMatches?: number;
        }>(call.arguments);
        const resolved = resolveAllowed(rootDir, args.path, readableRoots);
        const result = await grepFiles(rootDir, resolved, args);
        return ok(call, JSON.stringify(result));
      }

      case "read_file": {
        const args = parseArgs<{ path: string; startLine?: number; endLine?: number }>(call.arguments);
        const filePath = resolveAllowed(rootDir, args.path, readableRoots);
        return ok(call, sliceLines(await readFile(filePath, "utf8"), args.startLine, args.endLine));
      }

      case "create_file": {
        const args = parseArgs<{ path: string; content: string }>(call.arguments);
        const filePath = resolveAllowed(rootDir, args.path, writableRoots);
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, args.content, { encoding: "utf8", flag: "wx" });
        return ok(call, `Created ${toProjectPath(rootDir, filePath)}`);
      }

      case "write_file": {
        const args = parseArgs<{ path: string; content: string }>(call.arguments);
        const filePath = resolveAllowed(rootDir, args.path, writableRoots);
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, args.content, "utf8");
        return ok(call, `Wrote ${toProjectPath(rootDir, filePath)}`);
      }

      case "replace_in_file": {
        const args = parseArgs<{ path: string; oldText: string; newText: string; replaceAll?: boolean }>(call.arguments);
        const filePath = resolveAllowed(rootDir, args.path, writableRoots);
        const original = await readFile(filePath, "utf8");
        if (!args.oldText) throw new Error("oldText must not be empty.");
        const count = countOccurrences(original, args.oldText);
        if (count === 0) throw new Error("oldText was not found.");
        if (!args.replaceAll && count !== 1) {
          throw new Error(`oldText matched ${count} times. Set replaceAll=true or provide a more specific oldText.`);
        }
        // Single-user TUI contract: this read/count/write sequence is not
        // designed for concurrent external writers.
        const next = original.split(args.oldText).join(args.newText);
        await writeFile(filePath, next, "utf8");
        return ok(call, `Replaced ${args.replaceAll ? count : 1} occurrence(s) in ${toProjectPath(rootDir, filePath)}`);
      }

      case "append_file": {
        const args = parseArgs<{ path: string; content: string; createIfMissing?: boolean }>(call.arguments);
        const filePath = resolveAllowed(rootDir, args.path, writableRoots);
        await mkdir(dirname(filePath), { recursive: true });
        if (!args.createIfMissing) await assertFile(filePath);
        await appendFile(filePath, args.content, { encoding: "utf8", flag: "a" });
        return ok(call, `Appended ${args.content.length} char(s) to ${toProjectPath(rootDir, filePath)}`);
      }

      case "delete_file": {
        const args = parseArgs<{ path: string }>(call.arguments);
        const filePath = resolveAllowed(rootDir, args.path, writableRoots);
        await assertFile(filePath);
        // Single-user TUI contract: the path is expected not to change between
        // the file check and unlink.
        await unlink(filePath);
        return ok(call, `Deleted ${toProjectPath(rootDir, filePath)}`);
      }

      case "copy_file": {
        const args = parseArgs<{ sourcePath: string; targetPath: string; overwrite?: boolean }>(call.arguments);
        const sourcePath = resolveAllowed(rootDir, args.sourcePath, readableRoots);
        const targetPath = resolveAllowed(rootDir, args.targetPath, writableRoots);
        await assertFile(sourcePath);
        await prepareTarget(targetPath, Boolean(args.overwrite));
        await copyFile(sourcePath, targetPath);
        return ok(call, `Copied ${toProjectPath(rootDir, sourcePath)} to ${toProjectPath(rootDir, targetPath)}`);
      }

      case "move_file": {
        const args = parseArgs<{ sourcePath: string; targetPath: string; overwrite?: boolean }>(call.arguments);
        const sourcePath = resolveAllowed(rootDir, args.sourcePath, writableRoots);
        const targetPath = resolveAllowed(rootDir, args.targetPath, writableRoots);
        await assertFile(sourcePath);
        await prepareTarget(targetPath, Boolean(args.overwrite));
        await rename(sourcePath, targetPath);
        return ok(call, `Moved ${toProjectPath(rootDir, sourcePath)} to ${toProjectPath(rootDir, targetPath)}`);
      }

      default:
        return fail(call, `Unknown tool: ${call.name}`);
    }
  } catch (error) {
    return fail(call, error instanceof Error ? error.message : String(error));
  }
}

function parseArgs<T>(raw: string): T {
  return JSON.parse(raw || "{}") as T;
}

function resolveAllowed(rootDir: string, requestedPath: string, roots: string[]): string {
  if (!requestedPath || requestedPath.includes("\0")) {
    throw new Error("Path is required.");
  }

  if (resolve(requestedPath) === requestedPath) {
    throw new Error("Only project-relative paths are allowed.");
  }

  const root = resolve(rootDir);
  const resolved = resolve(root, requestedPath);
  const rel = relative(root, resolved);

  if (rel.startsWith("..") || rel === ".." || resolve(rel) === rel) {
    throw new Error(`Path escapes project root: ${requestedPath}`);
  }

  const normalized = rel.split(sep).join("/");
  const rootName = normalized.split("/")[0];
  if (!roots.includes(rootName)) {
    throw new Error(`Path must be under one of: ${roots.join(", ")}`);
  }

  return resolved;
}

function sliceLines(content: string, startLine: number | undefined, endLine: number | undefined): string {
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

async function grepFiles(
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

function countOccurrences(content: string, needle: string): number {
  let count = 0;
  let index = 0;
  while (true) {
    const next = content.indexOf(needle, index);
    if (next === -1) return count;
    count += 1;
    index = next + needle.length;
  }
}

async function assertFile(filePath: string): Promise<void> {
  const info = await stat(filePath);
  if (!info.isFile()) throw new Error("Path must be a file.");
}

async function prepareTarget(targetPath: string, overwrite: boolean): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true });
  const existing = await stat(targetPath).catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!existing) return;
  if (!existing.isFile()) throw new Error("Target path exists and is not a file.");
  if (!overwrite) throw new Error("Target file already exists. Set overwrite=true to replace it.");
  // Single-user TUI contract: overwrite is a stat/unlink/write sequence, not
  // a cross-process atomic replacement protocol.
  await unlink(targetPath);
}

async function listFiles(dir: string, recursive: boolean): Promise<string[]> {
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

    const info = await stat(fullPath).catch(() => undefined);
    if (info?.isFile()) {
      result.push(fullPath);
    }
  }

  return result.sort();
}

function toProjectPath(rootDir: string, filePath: string): string {
  return relative(rootDir, filePath).split(sep).join("/");
}

function ok(call: ToolCall, content: string): ToolResult {
  return {
    callId: call.id,
    name: call.name,
    ok: true,
    content,
  };
}

function fail(call: ToolCall, content: string): ToolResult {
  return {
    callId: call.id,
    name: call.name,
    ok: false,
    content,
  };
}
