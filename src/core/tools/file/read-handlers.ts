import { stat, readFile } from "node:fs/promises";
import { basename } from "node:path";
import { ingestImageBytes, ingestImageFile } from "../../attachments/store";
import { normalizeAssetPath, type AssetResolver } from "../../runtime/assets";
import type { FileToolEvent, ToolCall, ToolResult } from "../types";
import { assertDirectory } from "./mutation-operations";
import { isAssetPath, readableFileRoots, resolveAllowedPath, toProjectPath } from "./path-policy";
import { grepAssetFiles, grepFiles, listDirectoryEntries, listFiles, sliceLines } from "./query-operations";

export async function executeFileReadOperation(
  rootDir: string,
  call: ToolCall,
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
      const resolved = await resolveAllowedPath(rootDir, args.path, readableFileRoots);
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
      const dir = await resolveAllowedPath(rootDir, args.path, readableFileRoots);
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
      const dir = await resolveAllowedPath(rootDir, args.path, readableFileRoots);
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
      const resolved = assetRequest ? undefined : await resolveAllowedPath(rootDir, args.path, readableFileRoots);
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
      const filePath = await resolveAllowedPath(rootDir, args.path, readableFileRoots);
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
      const filePath = asset?.absolutePath ?? await resolveAllowedPath(rootDir, args.path, readableFileRoots);
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
      throw new Error(`Unknown read/query tool: ${call.name}`);
  }
}

function parseArgs<T>(raw: string): T {
  return JSON.parse(raw || "{}") as T;
}

function textByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function ok(call: ToolCall, content: string, fileEvent?: FileToolEvent): ToolResult {
  return { callId: call.id, name: call.name, ok: true, content, ...(fileEvent ? { fileEvent } : {}) };
}
