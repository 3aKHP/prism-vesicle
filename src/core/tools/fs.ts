import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
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
      name: "read_file",
      description: "Read a UTF-8 text file from an allowed Vesicle project directory.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Project-relative file path.",
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
];

export async function executeFileTool(rootDir: string, call: ToolCall): Promise<ToolResult> {
  try {
    switch (call.name) {
      case "list_files": {
        const args = parseArgs<{ path: string; recursive?: boolean }>(call.arguments);
        const dir = resolveAllowed(rootDir, args.path, readableRoots);
        const entries = await listFiles(dir, Boolean(args.recursive));
        return ok(call, entries.map((entry) => toProjectPath(rootDir, entry)).join("\n") || "(empty)");
      }

      case "read_file": {
        const args = parseArgs<{ path: string }>(call.arguments);
        const filePath = resolveAllowed(rootDir, args.path, readableRoots);
        return ok(call, await readFile(filePath, "utf8"));
      }

      case "write_file": {
        const args = parseArgs<{ path: string; content: string }>(call.arguments);
        const filePath = resolveAllowed(rootDir, args.path, writableRoots);
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, args.content, "utf8");
        return ok(call, `Wrote ${toProjectPath(rootDir, filePath)}`);
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

    if ((await stat(fullPath)).isFile()) {
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
