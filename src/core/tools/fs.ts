import type { Stats } from "node:fs";
import { appendFile, copyFile, lstat, mkdir, readdir, readFile, realpath, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { writableProjectRoots } from "../artifacts/roots";
import type { FileToolEvent, FileToolExecutionOptions, ToolCall, ToolDefinition, ToolResult } from "./types";
import { ingestImageBytes, ingestImageFile } from "../attachments/store";
import { createAssetResolver, normalizeAssetPath, type AssetResolver } from "../runtime/assets";

const readableRoots = ["assets", ...writableProjectRoots];
const writableRoots = [...writableProjectRoots];

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
      name: "list_directory",
      description: "List files, directories, and symbolic links under an allowed Vesicle project directory.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Project-relative directory path, such as workspace or workspace/part_01.",
          },
          recursive: {
            type: "boolean",
            description: "Whether to list descendants recursively. Defaults to false.",
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
      name: "view_image",
      description: "View an image under an allowed project root. Use this for visual inspection of files in source_materials, workspace, assets, novels, reports, or test_runs.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Project-relative image path under an allowed read root.",
          },
          detail: {
            type: "string",
            enum: ["auto", "high", "original"],
            description: "Image detail hint. Defaults to auto.",
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
      description: "Create a new UTF-8 project file. Fails if the file already exists.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Project-relative output path under source_materials, workspace, novels, reports, or test_runs.",
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
      name: "create_directory",
      description: "Create a directory under a writable project root. Fails if the target already exists.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Project-relative directory path below source_materials, workspace, novels, reports, or test_runs.",
          },
          recursive: {
            type: "boolean",
            description: "Create missing parent directories. Defaults to true.",
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
      description: "Create or overwrite a UTF-8 project file under source_materials, workspace, novels, reports, or test_runs.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Project-relative output path, such as source_materials/research.md or workspace/luotianyi.md.",
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
      description: "Replace exact text inside an existing writable UTF-8 project file.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Project-relative file path under source_materials, workspace, novels, reports, or test_runs.",
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
      description: "Append UTF-8 text to an existing writable project file.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Project-relative file path under source_materials, workspace, novels, reports, or test_runs.",
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
      description: "Delete a single writable project file. Directories are not deleted.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Project-relative file path under source_materials, workspace, novels, reports, or test_runs.",
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
      description: "Copy an allowed file to a writable project root.",
      parameters: {
        type: "object",
        properties: {
          sourcePath: {
            type: "string",
            description: "Project-relative source file path under an allowed read root.",
          },
          targetPath: {
            type: "string",
            description: "Project-relative target path under source_materials, workspace, novels, reports, or test_runs.",
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
      description: "Move or rename a file inside writable project roots.",
      parameters: {
        type: "object",
        properties: {
          sourcePath: {
            type: "string",
            description: "Project-relative source file path under source_materials, workspace, novels, reports, or test_runs.",
          },
          targetPath: {
            type: "string",
            description: "Project-relative target path under source_materials, workspace, novels, reports, or test_runs.",
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
      name: "move_directory",
      description: "Move or rename a directory tree inside writable project roots. The target must not exist.",
      parameters: {
        type: "object",
        properties: {
          sourcePath: {
            type: "string",
            description: "Existing project-relative directory path below a writable root.",
          },
          targetPath: {
            type: "string",
            description: "New project-relative directory path below a writable root.",
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
      name: "delete_directory",
      description: "Delete one empty directory below a writable project root. Fixed writable roots and non-empty directories are refused.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Project-relative empty directory path below source_materials, workspace, novels, reports, or test_runs.",
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
];

export async function executeFileTool(
  rootDir: string,
  call: ToolCall,
  options: FileToolExecutionOptions = {},
): Promise<ToolResult> {
  const assets = options.assets ?? createAssetResolver(rootDir);
  try {
    switch (call.name) {
      case "stat_path": {
        const args = parseArgs<{ path: string }>(call.arguments);
        if (isAssetRequest(args.path)) {
          const info = await assets.stat(args.path);
          return ok(call, JSON.stringify({
            path: info.logicalPath,
            type: info.type,
            size: info.size,
            modifiedAt: info.modifiedAt.toISOString(),
          }), {
            kind: "file_operation",
            operation: "stat",
            path: info.logicalPath,
            changed: false,
            bytes: info.size,
          });
        }
        const resolved = await resolveAllowed(rootDir, args.path, readableRoots);
        const info = await stat(resolved);
        return ok(call, JSON.stringify({
          path: toProjectPath(rootDir, resolved),
          type: info.isDirectory() ? "directory" : info.isFile() ? "file" : "other",
          size: info.size,
          modifiedAt: info.mtime.toISOString(),
        }), {
          kind: "file_operation",
          operation: "stat",
          path: toProjectPath(rootDir, resolved),
          changed: false,
          bytes: info.size,
        });
      }

      case "list_files": {
        const args = parseArgs<{ path: string; recursive?: boolean }>(call.arguments);
        if (isAssetRequest(args.path)) {
          const logicalPath = normalizeAssetPath(args.path, { allowRoot: true });
          const entries = await assets.listFiles(logicalPath, Boolean(args.recursive));
          return ok(call, entries.join("\n") || "(empty)", {
            kind: "file_operation",
            operation: "list",
            path: logicalPath,
            changed: false,
            entryCount: entries.length,
          });
        }
        const dir = await resolveAllowed(rootDir, args.path, readableRoots);
        const entries = await listFiles(dir, Boolean(args.recursive));
        return ok(call, entries.map((entry) => toProjectPath(rootDir, entry)).join("\n") || "(empty)", {
          kind: "file_operation",
          operation: "list",
          path: toProjectPath(rootDir, dir),
          changed: false,
          entryCount: entries.length,
        });
      }

      case "list_directory": {
        const args = parseArgs<{ path: string; recursive?: boolean }>(call.arguments);
        if (isAssetRequest(args.path)) {
          throw new Error("list_directory does not support the layered assets namespace; use list_files for assets.");
        }
        const dir = await resolveAllowed(rootDir, args.path, readableRoots);
        await assertDirectory(dir);
        const result = await listDirectoryEntries(rootDir, dir, Boolean(args.recursive));
        return ok(call, JSON.stringify(result), {
          kind: "file_operation",
          operation: "list_directory",
          path: toProjectPath(rootDir, dir),
          changed: false,
          entryCount: result.entries.length,
          truncated: result.truncated,
        });
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
        const assetRequest = isAssetRequest(args.path);
        const resolved = assetRequest ? undefined : await resolveAllowed(rootDir, args.path, readableRoots);
        const result = assetRequest
          ? await grepAssetFiles(assets, args.path, args)
          : await grepFiles(rootDir, resolved!, args);
        const eventPath = assetRequest
          ? normalizeAssetPath(args.path, { allowRoot: true })
          : toProjectPath(rootDir, resolved!);
        return ok(call, JSON.stringify(result), {
          kind: "file_operation",
          operation: "grep",
          path: eventPath,
          changed: false,
          matches: result.matches.length,
          truncated: result.truncated,
        });
      }

      case "read_file": {
        const args = parseArgs<{ path: string; startLine?: number; endLine?: number }>(call.arguments);
        if (isAssetRequest(args.path)) {
          const resolved = await assets.resolveFile(args.path);
          const content = sliceLines(await assets.readText(resolved.logicalPath), args.startLine, args.endLine);
          return ok(call, content, {
            kind: "file_operation",
            operation: "read",
            path: resolved.logicalPath,
            changed: false,
            bytes: textByteLength(content),
            lines: content ? content.split(/\r?\n/).length : 0,
          });
        }
        const filePath = await resolveAllowed(rootDir, args.path, readableRoots);
        const content = sliceLines(await readFile(filePath, "utf8"), args.startLine, args.endLine);
        return ok(call, content, {
          kind: "file_operation",
          operation: "read",
          path: toProjectPath(rootDir, filePath),
          changed: false,
          bytes: textByteLength(content),
          lines: content ? content.split(/\r?\n/).length : 0,
        });
      }

      case "view_image": {
        const args = parseArgs<{ path: string; detail?: "auto" | "high" | "original" }>(call.arguments);
        if (args.detail && !["auto", "high", "original"].includes(args.detail)) {
          throw new Error("view_image.detail must be auto, high, or original.");
        }
        const asset = isAssetRequest(args.path) ? await assets.resolveFile(args.path) : undefined;
        const filePath = asset?.absolutePath ?? await resolveAllowed(rootDir, args.path, readableRoots);
        const projectPath = asset?.logicalPath ?? toProjectPath(rootDir, filePath);
        const image = asset
          ? await ingestImageBytes(rootDir, await assets.readBytes(asset.logicalPath), {
              source: "project",
              filename: basename(asset.logicalPath),
              sourcePath: projectPath,
              detail: args.detail ?? "auto",
            })
          : await ingestImageFile(rootDir, filePath, {
              source: "project",
              sourcePath: projectPath,
              detail: args.detail ?? "auto",
            });
        return {
          ...ok(call, `Viewed ${projectPath}`, {
            kind: "file_operation",
            operation: "view",
            path: projectPath,
            changed: false,
            bytes: image.bytes,
          }),
          images: [image],
        };
      }

      case "create_file": {
        const args = parseArgs<{ path: string; content: string }>(call.arguments);
        const filePath = await resolveAllowed(rootDir, args.path, writableRoots);
        await options.beforeMutation?.(await mutationPathsForTarget(rootDir, filePath));
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, args.content, { encoding: "utf8", flag: "wx" });
        return ok(call, `Created ${toProjectPath(rootDir, filePath)}`, {
          kind: "file_operation",
          operation: "create",
          path: toProjectPath(rootDir, filePath),
          changed: true,
          bytes: textByteLength(args.content),
        });
      }

      case "create_directory": {
        const args = parseArgs<{ path: string; recursive?: boolean }>(call.arguments);
        const directoryPath = await resolveAllowed(rootDir, args.path, writableRoots);
        assertMutableDirectoryPath(rootDir, directoryPath);
        await assertMissing(directoryPath, "Directory already exists.");
        const recursive = args.recursive ?? true;
        const mutationPaths = recursive
          ? await mutationPathsForTarget(rootDir, directoryPath)
          : [toProjectPath(rootDir, directoryPath)];
        await options.beforeMutation?.(mutationPaths);
        await mkdir(directoryPath, { recursive });
        return ok(call, `Created directory ${toProjectPath(rootDir, directoryPath)}`, {
          kind: "file_operation",
          operation: "create_directory",
          path: toProjectPath(rootDir, directoryPath),
          changed: true,
        });
      }

      case "write_file": {
        const args = parseArgs<{ path: string; content: string }>(call.arguments);
        const filePath = await resolveAllowed(rootDir, args.path, writableRoots);
        await options.beforeMutation?.(await mutationPathsForTarget(rootDir, filePath));
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, args.content, "utf8");
        return ok(call, `Wrote ${toProjectPath(rootDir, filePath)}`, {
          kind: "file_operation",
          operation: "write",
          path: toProjectPath(rootDir, filePath),
          changed: true,
          bytes: textByteLength(args.content),
        });
      }

      case "replace_in_file": {
        const args = parseArgs<{ path: string; oldText: string; newText: string; replaceAll?: boolean }>(call.arguments);
        const filePath = await resolveAllowed(rootDir, args.path, writableRoots);
        const original = await readFile(filePath, "utf8");
        if (!args.oldText) throw new Error("oldText must not be empty.");
        const count = countOccurrences(original, args.oldText);
        if (count === 0) throw new Error("oldText was not found.");
        if (!args.replaceAll && count !== 1) {
          throw new Error(`oldText matched ${count} times. Set replaceAll=true or provide a more specific oldText.`);
        }
        await options.beforeMutation?.([toProjectPath(rootDir, filePath)]);
        // Single-user TUI contract: this read/count/write sequence is not
        // designed for concurrent external writers.
        const next = original.split(args.oldText).join(args.newText);
        await writeFile(filePath, next, "utf8");
        // 1-based start line of every matched occurrence (single → length 1,
        // replaceAll → one per region). Used for the diff's line-number gutter
        // and to list affected lines.
        const matchLines = collectMatchLines(original, args.oldText);
        return ok(call, `Replaced ${args.replaceAll ? count : 1} occurrence(s) in ${toProjectPath(rootDir, filePath)}`, {
          kind: "file_operation",
          operation: "replace",
          path: toProjectPath(rootDir, filePath),
          changed: true,
          bytes: textByteLength(next),
          occurrences: args.replaceAll ? count : 1,
          ...(matchLines.length > 0 ? { matchLines } : {}),
        });
      }

      case "append_file": {
        const args = parseArgs<{ path: string; content: string; createIfMissing?: boolean }>(call.arguments);
        const filePath = await resolveAllowed(rootDir, args.path, writableRoots);
        const mutationPaths = await mutationPathsForTarget(rootDir, filePath);
        if (!args.createIfMissing) await assertFile(filePath);
        await options.beforeMutation?.(mutationPaths);
        await mkdir(dirname(filePath), { recursive: true });
        await appendFile(filePath, args.content, { encoding: "utf8", flag: "a" });
        const appended = await stat(filePath);
        return ok(call, `Appended ${args.content.length} char(s) to ${toProjectPath(rootDir, filePath)}`, {
          kind: "file_operation",
          operation: "append",
          path: toProjectPath(rootDir, filePath),
          changed: true,
          bytes: appended.size,
          deltaBytes: textByteLength(args.content),
        });
      }

      case "delete_file": {
        const args = parseArgs<{ path: string }>(call.arguments);
        const filePath = await resolveAllowed(rootDir, args.path, writableRoots);
        const deleted = await assertFile(filePath);
        await options.beforeMutation?.([toProjectPath(rootDir, filePath)]);
        // Single-user TUI contract: the path is expected not to change between
        // the file check and unlink.
        await unlink(filePath);
        return ok(call, `Deleted ${toProjectPath(rootDir, filePath)}`, {
          kind: "file_operation",
          operation: "delete",
          path: toProjectPath(rootDir, filePath),
          changed: true,
          bytes: deleted.size,
        });
      }

      case "copy_file": {
        const args = parseArgs<{ sourcePath: string; targetPath: string; overwrite?: boolean }>(call.arguments);
        const sourceAsset = isAssetRequest(args.sourcePath) ? await assets.resolveFile(args.sourcePath) : undefined;
        const sourcePath = sourceAsset?.absolutePath ?? await resolveAllowed(rootDir, args.sourcePath, readableRoots);
        const logicalSourcePath = sourceAsset?.logicalPath ?? toProjectPath(rootDir, sourcePath);
        const targetPath = await resolveAllowed(rootDir, args.targetPath, writableRoots);
        const assetBytes = sourceAsset ? await assets.readBytes(sourceAsset.logicalPath) : undefined;
        const source = sourceAsset ? undefined : await assertFile(sourcePath);
        await options.beforeMutation?.(await mutationPathsForTarget(rootDir, targetPath));
        await prepareTarget(targetPath, Boolean(args.overwrite));
        if (assetBytes) await writeFile(targetPath, assetBytes);
        else await copyFile(sourcePath, targetPath);
        return ok(call, `Copied ${logicalSourcePath} to ${toProjectPath(rootDir, targetPath)}`, {
          kind: "file_operation",
          operation: "copy",
          sourcePath: logicalSourcePath,
          targetPath: toProjectPath(rootDir, targetPath),
          changed: true,
          bytes: assetBytes?.byteLength ?? source!.size,
        });
      }

      case "move_file": {
        const args = parseArgs<{ sourcePath: string; targetPath: string; overwrite?: boolean }>(call.arguments);
        const sourcePath = await resolveAllowed(rootDir, args.sourcePath, writableRoots);
        const targetPath = await resolveAllowed(rootDir, args.targetPath, writableRoots);
        const source = await assertFile(sourcePath);
        await options.beforeMutation?.([
          toProjectPath(rootDir, sourcePath),
          ...await mutationPathsForTarget(rootDir, targetPath),
        ]);
        await prepareTarget(targetPath, Boolean(args.overwrite));
        await rename(sourcePath, targetPath);
        return ok(call, `Moved ${toProjectPath(rootDir, sourcePath)} to ${toProjectPath(rootDir, targetPath)}`, {
          kind: "file_operation",
          operation: "move",
          sourcePath: toProjectPath(rootDir, sourcePath),
          targetPath: toProjectPath(rootDir, targetPath),
          changed: true,
          bytes: source.size,
        });
      }

      case "move_directory": {
        const args = parseArgs<{ sourcePath: string; targetPath: string }>(call.arguments);
        const sourcePath = await resolveAllowed(rootDir, args.sourcePath, writableRoots);
        const targetPath = await resolveAllowed(rootDir, args.targetPath, writableRoots);
        assertMutableDirectoryPath(rootDir, sourcePath);
        assertMutableDirectoryPath(rootDir, targetPath);
        await assertDirectory(sourcePath);
        await assertMissing(targetPath, "Target path already exists.");
        const targetParent = dirname(targetPath);
        await assertDirectory(targetParent);
        await options.beforeMutation?.([
          toProjectPath(rootDir, sourcePath),
          toProjectPath(rootDir, targetPath),
        ]);
        await rename(sourcePath, targetPath);
        return ok(call, `Moved directory ${toProjectPath(rootDir, sourcePath)} to ${toProjectPath(rootDir, targetPath)}`, {
          kind: "file_operation",
          operation: "move_directory",
          sourcePath: toProjectPath(rootDir, sourcePath),
          targetPath: toProjectPath(rootDir, targetPath),
          changed: true,
        });
      }

      case "delete_directory": {
        const args = parseArgs<{ path: string }>(call.arguments);
        const directoryPath = await resolveAllowed(rootDir, args.path, writableRoots);
        assertMutableDirectoryPath(rootDir, directoryPath);
        await assertDirectory(directoryPath);
        const entries = await readdir(directoryPath);
        if (entries.length > 0) throw new Error("Directory is not empty. Delete its contents first.");
        await options.beforeMutation?.([toProjectPath(rootDir, directoryPath)]);
        await rmdir(directoryPath);
        return ok(call, `Deleted directory ${toProjectPath(rootDir, directoryPath)}`, {
          kind: "file_operation",
          operation: "delete_directory",
          path: toProjectPath(rootDir, directoryPath),
          changed: true,
        });
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

function isAssetRequest(requestedPath: string): boolean {
  const normalized = requestedPath.replaceAll("\\", "/");
  return normalized === "assets" || normalized.startsWith("assets/");
}

async function resolveAllowed(rootDir: string, requestedPath: string, roots: string[]): Promise<string> {
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

  const realRoot = await realpath(root);
  const parts = normalized.split("/");
  let current = root;
  for (const part of parts) {
    current = resolve(current, part);
    const info = await lstat(current).catch((error: unknown) => {
      if (isEnoent(error)) return undefined;
      throw error;
    });
    if (!info) break;
    if (info.isSymbolicLink()) {
      throw new Error(`Symbolic links are not allowed in model-visible paths: ${requestedPath}`);
    }
    const actual = await realpath(current);
    if (!isWithin(realRoot, actual)) {
      throw new Error(`Path escapes project root through a linked path: ${requestedPath}`);
    }
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

async function grepAssetFiles(
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

/** 1-based start line of every occurrence of `needle` in `content`. */
function collectMatchLines(content: string, needle: string): number[] {
  const lines: number[] = [];
  let from = 0;
  while (true) {
    const idx = content.indexOf(needle, from);
    if (idx === -1) return lines;
    lines.push(content.slice(0, idx).split("\n").length);
    from = idx + needle.length;
  }
}

async function assertFile(filePath: string): Promise<Stats> {
  const info = await lstat(filePath);
  if (!info.isFile()) throw new Error("Path must be a file.");
  return info;
}

async function assertDirectory(directoryPath: string): Promise<Stats> {
  const info = await lstat(directoryPath);
  if (!info.isDirectory()) throw new Error("Path must be a directory.");
  return info;
}

async function assertMissing(targetPath: string, message: string): Promise<void> {
  const existing = await lstat(targetPath).catch((error: unknown) => {
    if (isEnoent(error)) return undefined;
    throw error;
  });
  if (existing) throw new Error(message);
}

function assertMutableDirectoryPath(rootDir: string, directoryPath: string): void {
  const projectPath = toProjectPath(rootDir, directoryPath);
  if (!projectPath.includes("/")) {
    throw new Error("Fixed writable roots cannot be created, moved, or deleted.");
  }
}

async function mutationPathsForTarget(rootDir: string, targetPath: string): Promise<string[]> {
  const root = resolve(rootDir);
  const paths = [toProjectPath(rootDir, targetPath)];
  let current = dirname(targetPath);
  while (current !== root) {
    const exists = await lstat(current).then(() => true).catch((error: unknown) => {
      if (isEnoent(error)) return false;
      throw error;
    });
    if (exists) break;
    paths.push(toProjectPath(rootDir, current));
    current = dirname(current);
  }
  return [...new Set(paths)].sort((left, right) => left.split("/").length - right.split("/").length);
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

async function listDirectoryEntries(
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

function isWithin(rootPath: string, candidatePath: string): boolean {
  const rel = relative(rootPath, candidatePath);
  return rel === "" || (!rel.startsWith("..") && rel !== ".." && resolve(rel) !== rel);
}

function isEnoent(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function toProjectPath(rootDir: string, filePath: string): string {
  return relative(rootDir, filePath).split(sep).join("/");
}

function textByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function ok(call: ToolCall, content: string, fileEvent?: FileToolEvent): ToolResult {
  return {
    callId: call.id,
    name: call.name,
    ok: true,
    content,
    ...(fileEvent ? { fileEvent } : {}),
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
