import { createHash } from "node:crypto";
import { appendFile, copyFile, mkdir, readdir, readFile, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { TextDecoder } from "node:util";
import type { AssetResolver } from "../../runtime/assets";
import type { FileToolEvent, FileToolExecutionOptions, ToolCall, ToolResult } from "../types";
import { fileTextByteLength, parseFileToolArgs, successfulFileToolResult } from "./handler-contract";
import {
  assertDirectory,
  assertFile,
  assertMissing,
  assertMutableDirectoryPath,
  mutationPathsForTarget,
  prepareTarget,
} from "./mutation-operations";
import {
  isAssetPath,
  readableFileRoots,
  resolveAllowedPath,
  toProjectPath,
  writableFileRoots,
} from "./path-policy";

export async function executeFileMutationOperation(
  rootDir: string,
  call: ToolCall,
  options: FileToolExecutionOptions,
  assets: AssetResolver,
): Promise<ToolResult> {
  switch (call.name) {
    case "create_file": {
      const args = parseFileToolArgs<{ path: string; content: string }>(call.arguments);
      const filePath = await resolveAllowedPath(rootDir, args.path, writableFileRoots);
      await options.beforeMutation?.(await mutationPathsForTarget(rootDir, filePath));
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, args.content, { encoding: "utf8", flag: "wx" });
      return successfulFileToolResult(call, `Created ${toProjectPath(rootDir, filePath)}`, changedFileEvent("create", rootDir, filePath, args.content));
    }

    case "create_directory": {
      const args = parseFileToolArgs<{ path: string; recursive?: boolean }>(call.arguments);
      const directoryPath = await resolveAllowedPath(rootDir, args.path, writableFileRoots);
      assertMutableDirectoryPath(rootDir, directoryPath);
      await assertMissing(directoryPath, "Directory already exists.");
      const recursive = args.recursive ?? true;
      const mutationPaths = recursive
        ? await mutationPathsForTarget(rootDir, directoryPath)
        : [toProjectPath(rootDir, directoryPath)];
      await options.beforeMutation?.(mutationPaths);
      await mkdir(directoryPath, { recursive });
      return successfulFileToolResult(call, `Created directory ${toProjectPath(rootDir, directoryPath)}`, {
        kind: "file_operation",
        operation: "create_directory",
        path: toProjectPath(rootDir, directoryPath),
        changed: true,
      });
    }

    case "write_file": {
      const args = parseFileToolArgs<{ path: string; content: string }>(call.arguments);
      const filePath = await resolveAllowedPath(rootDir, args.path, writableFileRoots);
      await options.beforeMutation?.(await mutationPathsForTarget(rootDir, filePath));
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, args.content, "utf8");
      return successfulFileToolResult(call, `Wrote ${toProjectPath(rootDir, filePath)}`, changedFileEvent("write", rootDir, filePath, args.content));
    }

    case "replace_in_file": {
      const args = parseFileToolArgs<{ path: string; oldText: string; newText: string; replaceAll?: boolean }>(call.arguments);
      const filePath = await resolveAllowedPath(rootDir, args.path, writableFileRoots);
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
      const matchLines = collectMatchLines(original, args.oldText);
      return successfulFileToolResult(call, `Replaced ${args.replaceAll ? count : 1} occurrence(s) in ${toProjectPath(rootDir, filePath)}`, {
        ...changedFileEvent("replace", rootDir, filePath, next),
        occurrences: args.replaceAll ? count : 1,
        ...(matchLines.length > 0 ? { matchLines } : {}),
      });
    }

    case "append_file": {
      const args = parseFileToolArgs<{ path: string; content: string; createIfMissing?: boolean }>(call.arguments);
      const filePath = await resolveAllowedPath(rootDir, args.path, writableFileRoots);
      if (!args.createIfMissing) await assertFile(filePath);
      const mutationPaths = args.createIfMissing
        ? await mutationPathsForTarget(rootDir, filePath)
        : [toProjectPath(rootDir, filePath)];
      await options.beforeMutation?.(mutationPaths);
      await mkdir(dirname(filePath), { recursive: true });
      await appendFile(filePath, args.content, { encoding: "utf8", flag: "a" });
      const appended = await readFile(filePath);
      return successfulFileToolResult(call, `Appended ${args.content.length} char(s) to ${toProjectPath(rootDir, filePath)}`, {
        kind: "file_operation",
        operation: "append",
        path: toProjectPath(rootDir, filePath),
        changed: true,
        bytes: appended.byteLength,
        sha256: sha256(appended),
        deltaBytes: fileTextByteLength(args.content),
      });
    }

    case "delete_file": {
      const args = parseFileToolArgs<{ path: string }>(call.arguments);
      const filePath = await resolveAllowedPath(rootDir, args.path, writableFileRoots);
      const deleted = await assertFile(filePath);
      await options.beforeMutation?.([toProjectPath(rootDir, filePath)]);
      await unlink(filePath);
      return successfulFileToolResult(call, `Deleted ${toProjectPath(rootDir, filePath)}`, {
        kind: "file_operation",
        operation: "delete",
        path: toProjectPath(rootDir, filePath),
        changed: true,
        bytes: deleted.size,
      });
    }

    case "copy_file": {
      const args = parseFileToolArgs<{ sourcePath: string; targetPath: string; overwrite?: boolean }>(call.arguments);
      const sourceAsset = isAssetPath(args.sourcePath) ? await assets.resolveFile(args.sourcePath) : undefined;
      const sourcePath = sourceAsset?.absolutePath ?? await resolveAllowedPath(rootDir, args.sourcePath, readableFileRoots);
      const logicalSourcePath = sourceAsset?.logicalPath ?? toProjectPath(rootDir, sourcePath);
      const targetPath = await resolveAllowedPath(rootDir, args.targetPath, writableFileRoots);
      const assetBytes = sourceAsset ? await assets.readBytes(sourceAsset.logicalPath) : undefined;
      const source = sourceAsset ? undefined : await assertFile(sourcePath);
      await options.beforeMutation?.(await mutationPathsForTarget(rootDir, targetPath));
      await prepareTarget(targetPath, Boolean(args.overwrite));
      if (assetBytes) await writeFile(targetPath, assetBytes);
      else await copyFile(sourcePath, targetPath);
      return successfulFileToolResult(call, `Copied ${logicalSourcePath} to ${toProjectPath(rootDir, targetPath)}`, {
        kind: "file_operation",
        operation: "copy",
        sourcePath: logicalSourcePath,
        targetPath: toProjectPath(rootDir, targetPath),
        changed: true,
        bytes: assetBytes?.byteLength ?? source!.size,
      });
    }

    case "move_file": {
      const args = parseFileToolArgs<{ sourcePath: string; targetPath: string; overwrite?: boolean }>(call.arguments);
      const sourcePath = await resolveAllowedPath(rootDir, args.sourcePath, writableFileRoots);
      const targetPath = await resolveAllowedPath(rootDir, args.targetPath, writableFileRoots);
      const source = await assertFile(sourcePath);
      await options.beforeMutation?.([
        toProjectPath(rootDir, sourcePath),
        ...await mutationPathsForTarget(rootDir, targetPath),
      ]);
      await prepareTarget(targetPath, Boolean(args.overwrite));
      await rename(sourcePath, targetPath);
      return successfulFileToolResult(call, `Moved ${toProjectPath(rootDir, sourcePath)} to ${toProjectPath(rootDir, targetPath)}`, {
        kind: "file_operation",
        operation: "move",
        sourcePath: toProjectPath(rootDir, sourcePath),
        targetPath: toProjectPath(rootDir, targetPath),
        changed: true,
        bytes: source.size,
      });
    }

    case "move_directory": {
      const args = parseFileToolArgs<{ sourcePath: string; targetPath: string }>(call.arguments);
      const sourcePath = await resolveAllowedPath(rootDir, args.sourcePath, writableFileRoots);
      const targetPath = await resolveAllowedPath(rootDir, args.targetPath, writableFileRoots);
      assertMutableDirectoryPath(rootDir, sourcePath);
      assertMutableDirectoryPath(rootDir, targetPath);
      await assertDirectory(sourcePath);
      await assertMissing(targetPath, "Target path already exists.");
      await assertDirectory(dirname(targetPath));
      await options.beforeMutation?.([
        toProjectPath(rootDir, sourcePath),
        toProjectPath(rootDir, targetPath),
      ]);
      await rename(sourcePath, targetPath);
      return successfulFileToolResult(call, `Moved directory ${toProjectPath(rootDir, sourcePath)} to ${toProjectPath(rootDir, targetPath)}`, {
        kind: "file_operation",
        operation: "move_directory",
        sourcePath: toProjectPath(rootDir, sourcePath),
        targetPath: toProjectPath(rootDir, targetPath),
        changed: true,
      });
    }

    case "delete_directory": {
      const args = parseFileToolArgs<{ path: string }>(call.arguments);
      const directoryPath = await resolveAllowedPath(rootDir, args.path, writableFileRoots);
      assertMutableDirectoryPath(rootDir, directoryPath);
      await assertDirectory(directoryPath);
      const entries = await readdir(directoryPath);
      if (entries.length > 0) throw new Error("Directory is not empty. Delete its contents first.");
      await options.beforeMutation?.([toProjectPath(rootDir, directoryPath)]);
      await rmdir(directoryPath);
      return successfulFileToolResult(call, `Deleted directory ${toProjectPath(rootDir, directoryPath)}`, {
        kind: "file_operation",
        operation: "delete_directory",
        path: toProjectPath(rootDir, directoryPath),
        changed: true,
      });
    }

    default:
      throw new Error(`Unknown tool: ${call.name}`);
  }
}

export async function readWritableProjectText(rootDir: string, requestedPath: string): Promise<{
  path: string;
  content: string;
  bytes: number;
  sha256: string;
}> {
  const filePath = await resolveAllowedPath(rootDir, requestedPath, writableFileRoots);
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

function changedFileEvent(
  operation: "create" | "write" | "replace",
  rootDir: string,
  filePath: string,
  content: string,
): FileToolEvent {
  return {
    kind: "file_operation",
    operation,
    path: toProjectPath(rootDir, filePath),
    changed: true,
    bytes: fileTextByteLength(content),
    sha256: sha256(content),
  };
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
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
