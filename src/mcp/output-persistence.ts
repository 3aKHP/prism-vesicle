import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Opt-in persistence of MCP tool-call outputs (#137B, slice 1). When the
 * project-level master toggle is on, every MCP call's text result is written
 * under `tmp/mcp-output/<sessionId>/` and its decoded images under
 * `.../blob/`, as native files the model can re-read with the existing
 * `read_file` / `grep_files` / `view_image` tools. Persistence is additive:
 * the inline delivery path (#175) is unchanged, and a persistence failure is
 * best-effort and must never change the MCP tool result.
 */

export type McpOutputPersistenceTarget = {
  sessionId: string;
  toolCallId: string;
  serverId: string;
  toolName: string;
  /** Raw JSON arguments string, used only to derive a meaningful filename slug. */
  arguments: string;
};

export type PersistableMcpImage = {
  bytes: Uint8Array;
  mediaType: string;
};

const maxArgSlugChars = 40;
const maxBaseNameChars = 80;

/** Relative directory (under the project scratch root) for one session's spills. */
export function mcpOutputSessionDir(sessionId: string): string {
  return `tmp/mcp-output/${sessionId}`;
}

/**
 * Persist one MCP call's text and images. Filenames are meaningful
 * (`<server>-<tool>__<argSlug>-<callHash>`) and unique per call. May throw for
 * filesystem errors; the caller treats persistence as best-effort (see
 * `maybePersistMcpOutput`), so a failure never alters the tool result. Returns
 * the project-relative paths written, so the caller can reference the full copy
 * when truncating the inline result.
 */
export async function persistMcpOutput(
  rootDir: string,
  target: McpOutputPersistenceTarget,
  text: string,
  images: PersistableMcpImage[],
): Promise<{ textPath?: string; imagePaths: string[] }> {
  const sessionRel = mcpOutputSessionDir(target.sessionId);
  const dir = join(rootDir, sessionRel);
  const blobDir = join(dir, "blob");
  await mkdir(blobDir, { recursive: true });
  const base = persistenceBaseName(target);

  let textPath: string | undefined;
  if (text.length > 0) {
    textPath = `${sessionRel}/${base}.txt`;
    await writeFile(join(dir, `${base}.txt`), text, "utf8");
  }
  await Promise.all(
    images.map((image, index) => {
      const extension = imageExtension(image.mediaType);
      return writeFile(join(blobDir, `${base}-image-${index + 1}.${extension}`), image.bytes);
    }),
  );
  const imagePaths = images.map((image, index) => {
    const extension = imageExtension(image.mediaType);
    return `${sessionRel}/blob/${base}-image-${index + 1}.${extension}`;
  });
  return { ...(textPath ? { textPath } : {}), imagePaths };
}

/**
 * Inline hard cap for a single MCP text result (#137B): at or above this UTF-8
 * byte length, a result is delivered inline as a bounded preview plus a
 * reference to the persisted full copy (when auto-truncate is on). Byte-based
 * so CJK and English are bounded consistently; ~8–16K tokens, well under a
 * typical context-window fraction. Tunable default pending broader fixtures.
 */
export const MCP_INLINE_TRUNCATE_THRESHOLD_BYTES = 32 * 1024;
const MCP_INLINE_PREVIEW_BYTES = 4 * 1024;

/** Whether an MCP text result is large enough to be auto-truncated inline. */
export function shouldTruncateMcpOutput(text: string): boolean {
  return Buffer.byteLength(text, "utf8") >= MCP_INLINE_TRUNCATE_THRESHOLD_BYTES;
}

/**
 * Compose the inline replacement for a truncated MCP text result: a bounded
 * preview followed by a reference to the persisted full copy. The preview is
 * byte-sliced, so it may end mid-character for multi-byte content; the model
 * reads the referenced file for the exact full body.
 */
export function composeTruncatedMcpPreview(text: string, textPath: string): string {
  const totalBytes = Buffer.byteLength(text, "utf8");
  const preview = Buffer.from(text, "utf8").subarray(0, MCP_INLINE_PREVIEW_BYTES).toString("utf8");
  return `${preview}\n\n[MCP output truncated: ${totalBytes} bytes total. Full result persisted at ${textPath} — use read_file (offsetBytes/maxBytes for large files) to view it.]`;
}

/**
 * Compose the system-prompt hint that tells the model where MCP outputs are
 * persisted and how to read them back. Always returns a non-empty block;
 * callers are responsible for gating it on the master toggle and on actual MCP
 * availability (`mcpRegistry.definitions.length > 0`). Appended by the prompt
 * builders and re-appended by `refreshLiveSystemPrompt`, mirroring the Skill
 * catalog block.
 */
export function composeMcpOutputPersistenceHint(sessionId: string): string {
  const sessionDir = mcpOutputSessionDir(sessionId);
  return [
    `<mcp_output_persistence>`,
    `MCP tool outputs for this session are persisted as files under ${sessionDir}/ (text results) and ${sessionDir}/blob/ (images). Use read_file, grep_files, and view_image to consult them later instead of requesting the same data again. Filenames are derived from the tool and its arguments.`,
    `These files are scratch: they are not rewind-safe and are not cleaned automatically. Remove them with the file tools when no longer needed.`,
    `</mcp_output_persistence>`,
  ].join("\n");
}

function persistenceBaseName(target: McpOutputPersistenceTarget): string {
  const tool = sanitizeFileName(`${target.serverId}-${target.toolName}`);
  const slug = argSlug(target.arguments);
  const callHash = createHash("sha256").update(target.toolCallId).digest("hex").slice(0, 8);
  const raw = `${tool}__${slug}-${callHash}`;
  return raw.slice(0, maxBaseNameChars);
}

/**
 * Derive a short, meaningful slug from the call's first scalar argument so a
 * listing of persisted outputs is greppable. Falls back to a hash of the raw
 * arguments when no usable scalar is present.
 */
function argSlug(rawArgs: string): string {
  if (rawArgs.length > 0) {
    try {
      const parsed: unknown = JSON.parse(rawArgs);
      if (parsed && typeof parsed === "object") {
        for (const value of Object.values(parsed as Record<string, unknown>)) {
          if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
            return sanitizeFileName(String(value)).slice(0, maxArgSlugChars);
          }
        }
      } else if (typeof parsed === "string" || typeof parsed === "number" || typeof parsed === "boolean") {
        return sanitizeFileName(String(parsed)).slice(0, maxArgSlugChars);
      }
    } catch {
      // Fall through to the hash fallback for non-JSON arguments.
    }
  }
  return createHash("sha256").update(rawArgs || "args").digest("hex").slice(0, 8);
}

function imageExtension(mediaType: string): string {
  if (mediaType === "image/jpeg") return "jpg";
  const suffix = mediaType.startsWith("image/") ? mediaType.slice("image/".length) : mediaType;
  return sanitizeFileName(suffix) || "bin";
}

function sanitizeFileName(value: string): string {
  const cleaned = value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "x";
}
