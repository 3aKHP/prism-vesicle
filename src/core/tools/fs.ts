import { createHash } from "node:crypto";
import { appendFile, copyFile, mkdir, readdir, readFile, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { writableProjectRoots } from "../artifacts/roots";
import type { FileToolEvent, FileToolExecutionOptions, ToolCall, ToolResult } from "./types";
import { ingestImageBytes, ingestImageFile } from "../attachments/store";
import { createAssetResolver, normalizeAssetPath, type AssetResolver } from "../runtime/assets";
import { isAssetPath, resolveAllowedPath, toProjectPath } from "./file/path-policy";
import { grepAssetFiles, grepFiles, listDirectoryEntries, listFiles, sliceLines } from "./file/query-operations";
import { assertDirectory, assertFile, assertMissing, assertMutableDirectoryPath, mutationPathsForTarget, prepareTarget } from "./file/mutation-operations";
export { fileToolDefinitions } from "./file/definitions";

const readableRoots = ["assets", ...writableProjectRoots];
const writableRoots = [...writableProjectRoots];


export async function executeFileTool(
  rootDir: string,
  call: ToolCall,
  options: FileToolExecutionOptions = {},
): Promise<ToolResult> {
  const assets = options.assets ?? createAssetResolver(rootDir);
  try {
    if (["stat_path", "list_files", "list_directory", "grep_files", "read_file", "view_image"].includes(call.name)) {
      return await executeFileReadOperation(rootDir, call, options, assets);
    }
    return await executeFileMutationOperation(rootDir, call, options, assets);
  } catch (error) {
    return fail(call, error instanceof Error ? error.message : String(error));
  }
}

async function executeFileReadOperation(
  rootDir: string,
  call: ToolCall,
  options: FileToolExecutionOptions,
  assets: AssetResolver,
): Promise<ToolResult> {
  switch (call.name) {
      case "stat_path": {
        const args = parseArgs<{ path: string }>(call.arguments);
        if (isAssetPath(args.path)) {
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
        const resolved = await resolveAllowedPath(rootDir, args.path, readableRoots);
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
        if (isAssetPath(args.path)) {
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
        const dir = await resolveAllowedPath(rootDir, args.path, readableRoots);
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
        if (isAssetPath(args.path)) {
          throw new Error("list_directory does not support the layered assets namespace; use list_files for assets.");
        }
        const dir = await resolveAllowedPath(rootDir, args.path, readableRoots);
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
        const assetRequest = isAssetPath(args.path);
        const resolved = assetRequest ? undefined : await resolveAllowedPath(rootDir, args.path, readableRoots);
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
        if (isAssetPath(args.path)) {
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
        const filePath = await resolveAllowedPath(rootDir, args.path, readableRoots);
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
        const asset = isAssetPath(args.path) ? await assets.resolveFile(args.path) : undefined;
        const filePath = asset?.absolutePath ?? await resolveAllowedPath(rootDir, args.path, readableRoots);
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

      default:
        return fail(call, `Unknown read/query tool: ${call.name}`);
    }
}

async function executeFileMutationOperation(
  rootDir: string,
  call: ToolCall,
  options: FileToolExecutionOptions,
  assets: AssetResolver,
): Promise<ToolResult> {
  switch (call.name) {
      case "create_file": {
        const args = parseArgs<{ path: string; content: string }>(call.arguments);
        const filePath = await resolveAllowedPath(rootDir, args.path, writableRoots);
        await options.beforeMutation?.(await mutationPathsForTarget(rootDir, filePath));
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, args.content, { encoding: "utf8", flag: "wx" });
        return ok(call, `Created ${toProjectPath(rootDir, filePath)}`, {
          kind: "file_operation",
          operation: "create",
          path: toProjectPath(rootDir, filePath),
          changed: true,
          bytes: textByteLength(args.content),
          sha256: sha256(args.content),
        });
      }

      case "create_directory": {
        const args = parseArgs<{ path: string; recursive?: boolean }>(call.arguments);
        const directoryPath = await resolveAllowedPath(rootDir, args.path, writableRoots);
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
        const filePath = await resolveAllowedPath(rootDir, args.path, writableRoots);
        await options.beforeMutation?.(await mutationPathsForTarget(rootDir, filePath));
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, args.content, "utf8");
        return ok(call, `Wrote ${toProjectPath(rootDir, filePath)}`, {
          kind: "file_operation",
          operation: "write",
          path: toProjectPath(rootDir, filePath),
          changed: true,
          bytes: textByteLength(args.content),
          sha256: sha256(args.content),
        });
      }

      case "replace_in_file": {
        const args = parseArgs<{ path: string; oldText: string; newText: string; replaceAll?: boolean }>(call.arguments);
        const filePath = await resolveAllowedPath(rootDir, args.path, writableRoots);
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
          sha256: sha256(next),
          occurrences: args.replaceAll ? count : 1,
          ...(matchLines.length > 0 ? { matchLines } : {}),
        });
      }

      case "append_file": {
        const args = parseArgs<{ path: string; content: string; createIfMissing?: boolean }>(call.arguments);
        const filePath = await resolveAllowedPath(rootDir, args.path, writableRoots);
        if (!args.createIfMissing) await assertFile(filePath);
        const mutationPaths = args.createIfMissing
          ? await mutationPathsForTarget(rootDir, filePath)
          : [toProjectPath(rootDir, filePath)];
        await options.beforeMutation?.(mutationPaths);
        await mkdir(dirname(filePath), { recursive: true });
        await appendFile(filePath, args.content, { encoding: "utf8", flag: "a" });
        const appended = await readFile(filePath);
        return ok(call, `Appended ${args.content.length} char(s) to ${toProjectPath(rootDir, filePath)}`, {
          kind: "file_operation",
          operation: "append",
          path: toProjectPath(rootDir, filePath),
          changed: true,
          bytes: appended.byteLength,
          sha256: sha256(appended),
          deltaBytes: textByteLength(args.content),
        });
      }

      case "delete_file": {
        const args = parseArgs<{ path: string }>(call.arguments);
        const filePath = await resolveAllowedPath(rootDir, args.path, writableRoots);
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
        const sourceAsset = isAssetPath(args.sourcePath) ? await assets.resolveFile(args.sourcePath) : undefined;
        const sourcePath = sourceAsset?.absolutePath ?? await resolveAllowedPath(rootDir, args.sourcePath, readableRoots);
        const logicalSourcePath = sourceAsset?.logicalPath ?? toProjectPath(rootDir, sourcePath);
        const targetPath = await resolveAllowedPath(rootDir, args.targetPath, writableRoots);
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
        const sourcePath = await resolveAllowedPath(rootDir, args.sourcePath, writableRoots);
        const targetPath = await resolveAllowedPath(rootDir, args.targetPath, writableRoots);
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
        const sourcePath = await resolveAllowedPath(rootDir, args.sourcePath, writableRoots);
        const targetPath = await resolveAllowedPath(rootDir, args.targetPath, writableRoots);
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
        const directoryPath = await resolveAllowedPath(rootDir, args.path, writableRoots);
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
}

function parseArgs<T>(raw: string): T {
  return JSON.parse(raw || "{}") as T;
}

export async function readWritableProjectText(rootDir: string, requestedPath: string): Promise<{
  path: string;
  content: string;
  bytes: number;
  sha256: string;
}> {
  const filePath = await resolveAllowedPath(rootDir, requestedPath, writableRoots);
  await assertFile(filePath);
  const bytes = await readFile(filePath);
  const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return {
    path: toProjectPath(rootDir, filePath),
    content,
    bytes: bytes.byteLength,
    sha256: sha256(bytes),
  };
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function textByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
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

function collectMatchLines(content: string, needle: string): number[] {
  const lines: number[] = [];
  let from = 0;
  while (true) {
    const index = content.indexOf(needle, from);
    if (index === -1) return lines;
    lines.push(content.slice(0, index).split("\n").length);
    from = index + needle.length;
  }
}

function ok(call: ToolCall, content: string, fileEvent?: FileToolEvent): ToolResult {
  return { callId: call.id, name: call.name, ok: true, content, ...(fileEvent ? { fileEvent } : {}) };
}

function fail(call: ToolCall, content: string): ToolResult {
  return { callId: call.id, name: call.name, ok: false, content };
}
