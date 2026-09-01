import { lstat, stat, readFile } from "node:fs/promises";
import { basename } from "node:path";
import { assertImageAttachmentSize, ingestImageBytes, ingestImageFile } from "../../attachments/store";
import { normalizeAssetPath, type AssetResolver } from "../../runtime/assets";
import { normalizeSkillMountPath } from "../../skills/mount";
import type { SkillMount } from "../../skills/mount";
import type { ToolCall, ToolResult } from "../types";
import { fileTextByteLength, parseFileToolArgs, successfulFileToolResult } from "./handler-contract";
import { isAssetPath, isMissingPathError, isSkillPath, readableFileRoots, resolveAllowedPath, toProjectPath } from "./path-policy";
import { grepAssetFiles, grepFiles, grepSkillFiles, listDirectoryEntries, readByteSlice, sliceLines } from "./query-operations";
import type { GrepOutputMode } from "./query-operations";

export async function executeFileReadOperation(
  rootDir: string,
  call: ToolCall,
  assets: AssetResolver,
  skillMount?: SkillMount,
): Promise<ToolResult> {
  switch (call.name) {
    case "stat_path": {
      const args = parseFileToolArgs<{ path: string }>(call.arguments);
      if (isAssetPath(args.path)) {
        const logicalPath = normalizeAssetPath(args.path, { allowRoot: true });
        const info = await assets.statIfExists(logicalPath);
        if (!info) return statNotFound(call, logicalPath);
        return successfulFileToolResult(call, JSON.stringify({
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
      if (isSkillPath(args.path)) {
        const logicalPath = normalizeSkillMountPath(args.path);
        const info = await requireSkillMount(skillMount).stat(logicalPath);
        if (!info) return statNotFound(call, logicalPath);
        return successfulFileToolResult(call, JSON.stringify({
          path: logicalPath,
          type: info.type,
          size: info.size,
          modifiedAt: info.modifiedAt.toISOString(),
        }), {
          kind: "file_operation",
          operation: "stat",
          path: logicalPath,
          changed: false,
          bytes: info.size,
        });
      }
      const resolved = await resolveAllowedPath(rootDir, args.path, readableFileRoots);
      const info = await stat(resolved).catch((error: unknown) => {
        if (isMissingPathError(error)) return undefined;
        throw error;
      });
      const projectPath = toProjectPath(rootDir, resolved);
      if (!info) return statNotFound(call, projectPath);
      return successfulFileToolResult(call, JSON.stringify({
        path: projectPath,
        type: info.isDirectory() ? "directory" : info.isFile() ? "file" : "other",
        size: info.size,
        modifiedAt: info.mtime.toISOString(),
      }), {
        kind: "file_operation",
        operation: "stat",
        path: projectPath,
        changed: false,
        bytes: info.size,
      });
    }

    case "list_directory": {
      const args = parseFileToolArgs<{ path: string; recursive?: boolean; detail?: "full" | "names" }>(call.arguments);
      const detail = args.detail ?? "full";
      if (detail !== "full" && detail !== "names") throw new Error("list_directory.detail must be full or names.");
      if (isVirtualRoot(args.path)) return listVirtualRoot(call, detail, Boolean(skillMount));
      if (isAssetPath(args.path)) {
        const logicalPath = normalizeAssetPath(args.path, { allowRoot: true });
        const info = await assets.statIfExists(logicalPath);
        if (!info) return directoryListResult(call, logicalPath, detail, "not_found", [], false, 0, 0, 0);
        if (info.type !== "directory") return directoryListResult(call, logicalPath, detail, "not_directory", [], false, 0, 0, 0);
        const result = await assets.listDirectory(logicalPath, {
          recursive: Boolean(args.recursive),
          filesOnly: detail === "names",
        });
        if (!result) return directoryListResult(call, logicalPath, detail, "not_found", [], false, 0, 0, 0);
        const entries = detail === "names"
          ? result.entries.map((entry) => entry.path)
          : result.entries.map((entry) => ({ ...entry, modifiedAt: entry.modifiedAt.toISOString() }));
        return directoryListResult(call, logicalPath, detail, "ok", entries, result.truncated, result.fileCount, result.directoryCount, 0);
      }
      if (isSkillPath(args.path)) {
        const logicalPath = normalizeSkillMountPath(args.path);
        const mount = requireSkillMount(skillMount);
        const info = await mount.stat(logicalPath);
        if (!info) return directoryListResult(call, logicalPath, detail, "not_found", [], false, 0, 0, 0);
        if (info.type !== "directory") return directoryListResult(call, logicalPath, detail, "not_directory", [], false, 0, 0, 0);
        const result = await mount.listDirectory(logicalPath, {
          recursive: Boolean(args.recursive),
          filesOnly: detail === "names",
        });
        if (!result) return directoryListResult(call, logicalPath, detail, "not_found", [], false, 0, 0, 0);
        const entries = detail === "names"
          ? result.entries.map((entry) => entry.path)
          : result.entries.map((entry) => ({ ...entry, modifiedAt: entry.modifiedAt.toISOString() }));
        return directoryListResult(call, logicalPath, detail, "ok", entries, result.truncated, result.fileCount, result.directoryCount, 0);
      }
      const dir = await resolveAllowedPath(rootDir, args.path, readableFileRoots);
      const projectPath = toProjectPath(rootDir, dir);
      const info = await lstat(dir).catch((error: unknown) => {
        if (isMissingPathError(error)) return undefined;
        throw error;
      });
      if (!info) return directoryListResult(call, projectPath, detail, "not_found", [], false, 0, 0, 0);
      if (!info.isDirectory()) return directoryListResult(call, projectPath, detail, "not_directory", [], false, 0, 0, 0);
      const result = await listDirectoryEntries(rootDir, dir, {
        recursive: Boolean(args.recursive),
        filesOnly: detail === "names",
      });
      const entries = detail === "names" ? result.entries.map((entry) => entry.path) : result.entries;
      return directoryListResult(call, projectPath, detail, "ok", entries, result.truncated, result.fileCount, result.directoryCount, result.otherCount);
    }

    case "grep_files": {
      const args = parseFileToolArgs<{
        path: string;
        pattern: string;
        regex?: boolean;
        caseSensitive?: boolean;
        recursive?: boolean;
        maxMatches?: number;
        contextLines?: number;
        outputMode?: GrepOutputMode;
      }>(call.arguments);
      const assetRequest = isAssetPath(args.path);
      const skillRequest = isSkillPath(args.path);
      const resolved = assetRequest || skillRequest ? undefined : await resolveAllowedPath(rootDir, args.path, readableFileRoots);
      const result = assetRequest
        ? await grepAssetFiles(assets, args.path, args)
        : skillRequest
          ? await grepSkillFiles(requireSkillMount(skillMount), args.path, args)
          : await grepFiles(rootDir, resolved!, args);
      const eventPath = pickResultPath({ assetRequest, skillRequest, requestedPath: args.path, rootDir, resolved });
      const base = {
        kind: "file_operation" as const,
        operation: "grep" as const,
        path: eventPath,
        changed: false,
        outputMode: result.outputMode,
        truncated: result.truncated,
      };
      const fileEvent = result.outputMode === "content"
        ? { ...base, matches: result.matches.length }
        : result.outputMode === "files_with_matches"
          ? { ...base, fileCount: result.files.length }
          : { ...base, matches: result.totalMatches, fileCount: result.counts.length };
      return successfulFileToolResult(call, JSON.stringify(result), fileEvent);
    }

    case "read_file": {
      const args = parseFileToolArgs<{ path: string; startLine?: number; endLine?: number; offsetBytes?: number; maxBytes?: number }>(call.arguments);
      if (args.offsetBytes !== undefined && args.maxBytes === undefined) {
        throw new Error("read_file offsetBytes requires maxBytes; provide maxBytes for a bounded slice or use startLine/endLine for a line range.");
      }
      if (args.maxBytes !== undefined) {
        // Bounded byte-offset read (#137B): does not load the whole file, so it
        // suits large persisted MCP outputs and giant single-line payloads.
        if (isAssetPath(args.path)) throw new Error("read_file offsetBytes/maxBytes is not supported for the assets namespace; use startLine/endLine.");
        if (isSkillPath(args.path)) throw new Error("read_file offsetBytes/maxBytes is not supported for the skills mount; use startLine/endLine.");
        const filePath = await resolveAllowedPath(rootDir, args.path, readableFileRoots);
        const slice = await readByteSlice(filePath, args.offsetBytes ?? 0, args.maxBytes);
        return successfulFileToolResult(call, slice.content, {
          kind: "file_operation",
          operation: "read",
          path: toProjectPath(rootDir, filePath),
          changed: false,
          bytes: slice.bytes,
          lines: slice.content ? slice.content.split(/\r?\n/).length : 0,
          ...(slice.truncated ? { truncated: true } : {}),
        });
      }
      if (isAssetPath(args.path)) {
        const resolved = await assets.resolveFile(args.path);
        const content = sliceLines(await assets.readText(resolved.logicalPath), args.startLine, args.endLine);
        return successfulFileToolResult(call, content, {
          kind: "file_operation",
          operation: "read",
          path: resolved.logicalPath,
          changed: false,
          bytes: fileTextByteLength(content),
          lines: content ? content.split(/\r?\n/).length : 0,
        });
      }
      if (isSkillPath(args.path)) {
        const logicalPath = normalizeSkillMountPath(args.path);
        const read = await requireSkillMount(skillMount).readText(logicalPath);
        const content = sliceLines(read.text, args.startLine, args.endLine);
        const body = read.note ? `${content}\n${read.note}` : content;
        return successfulFileToolResult(call, body, {
          kind: "file_operation",
          operation: "read",
          path: logicalPath,
          changed: false,
          bytes: fileTextByteLength(content),
          lines: content ? content.split(/\r?\n/).length : 0,
          ...(read.truncated ? { truncated: true } : {}),
        });
      }
      const filePath = await resolveAllowedPath(rootDir, args.path, readableFileRoots);
      const content = sliceLines(await readFile(filePath, "utf8"), args.startLine, args.endLine);
      return successfulFileToolResult(call, content, {
        kind: "file_operation",
        operation: "read",
        path: toProjectPath(rootDir, filePath),
        changed: false,
        bytes: fileTextByteLength(content),
        lines: content ? content.split(/\r?\n/).length : 0,
      });
    }

    case "view_image": {
      const args = parseFileToolArgs<{ path: string; detail?: "auto" | "high" | "original" }>(call.arguments);
      if (args.detail && !["auto", "high", "original"].includes(args.detail)) {
        throw new Error("view_image.detail must be auto, high, or original.");
      }
      if (isSkillPath(args.path)) {
        const logicalPath = normalizeSkillMountPath(args.path);
        const mount = requireSkillMount(skillMount);
        // Pre-flight the shared image cap so an oversized bundled asset is
        // rejected before readBytes buffers the whole file.
        const info = await mount.stat(logicalPath);
        if (info?.type === "file" && info.size !== undefined) assertImageAttachmentSize(info.size);
        const bytes = await mount.readBytes(logicalPath);
        const image = await ingestImageBytes(rootDir, bytes, {
          source: "project",
          filename: basename(logicalPath),
          sourcePath: logicalPath,
          detail: args.detail ?? "auto",
        });
        return {
          ...successfulFileToolResult(call, `Viewed ${logicalPath}`, {
            kind: "file_operation",
            operation: "view",
            path: logicalPath,
            changed: false,
            bytes: image.bytes,
          }),
          images: [image],
        };
      }
      const asset = isAssetPath(args.path) ? await assets.resolveFile(args.path) : undefined;
      const filePath = asset?.absolutePath ?? await resolveAllowedPath(rootDir, args.path, readableFileRoots);
      const projectPath = asset?.logicalPath ?? toProjectPath(rootDir, filePath);
      if (asset) {
        // Same pre-flight as the skills mount: reject oversized assets before
        // readBytes buffers the whole file.
        const assetInfo = await assets.statIfExists(asset.logicalPath);
        if (assetInfo?.type === "file") assertImageAttachmentSize(assetInfo.size);
      }
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
        ...successfulFileToolResult(call, `Viewed ${projectPath}`, {
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

function isVirtualRoot(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  return normalized === "." || normalized === "./";
}

/** Fail closed when a `skills/` path arrives without a wired session mount. */
function requireSkillMount(mount: SkillMount | undefined): SkillMount {
  if (!mount) {
    throw new Error("The skills/ mount is unavailable: no Skill catalog is active in this session.");
  }
  return mount;
}

/** Canonical event path for a diverted (assets/skills) or resolved read target. */
function pickResultPath(diversion: {
  assetRequest: boolean;
  skillRequest: boolean;
  requestedPath: string;
  rootDir: string;
  resolved?: string;
}): string {
  if (diversion.skillRequest) return normalizeSkillMountPath(diversion.requestedPath);
  if (diversion.assetRequest) return normalizeAssetPath(diversion.requestedPath, { allowRoot: true });
  return toProjectPath(diversion.rootDir, diversion.resolved!);
}

function listVirtualRoot(call: ToolCall, detail: "full" | "names", skillsMounted: boolean): ToolResult {
  const roots = skillsMounted ? [...readableFileRoots, "skills"] : [...readableFileRoots];
  const entries = detail === "names"
    ? roots
    : roots.map((path) => ({
      path,
      type: "directory" as const,
      ...(path === "assets" || path === "skills" ? { readOnly: true } : {}),
    }));
  return directoryListResult(call, ".", detail, "ok", entries, false, 0, roots.length, 0);
}

function statNotFound(call: ToolCall, path: string): ToolResult {
  return successfulFileToolResult(call, JSON.stringify({ path, type: "not_found" }), {
    kind: "file_operation",
    operation: "stat",
    path,
    changed: false,
  });
}

function directoryListResult(
  call: ToolCall,
  path: string,
  detail: "full" | "names",
  status: "ok" | "not_found" | "not_directory",
  entries: unknown[],
  truncated: boolean,
  fileCount: number,
  directoryCount: number,
  otherCount: number,
): ToolResult {
  return successfulFileToolResult(call, JSON.stringify({
    path,
    status,
    detail,
    entries,
    fileCount,
    directoryCount,
    otherCount,
    empty: status === "ok" && fileCount === 0 && directoryCount === 0 && otherCount === 0,
    truncated,
  }), {
    kind: "file_operation",
    operation: "list_directory",
    path,
    changed: false,
    entryCount: entries.length,
    truncated,
  });
}
