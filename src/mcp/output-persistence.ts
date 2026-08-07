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
 * (`<server>-<tool>__<argSlug>-<callHash>`) and unique per call. Never throws
 * for expected filesystem errors — the caller treats persistence as best-effort.
 */
export async function persistMcpOutput(
  rootDir: string,
  target: McpOutputPersistenceTarget,
  text: string,
  images: PersistableMcpImage[],
): Promise<void> {
  const dir = join(rootDir, mcpOutputSessionDir(target.sessionId));
  const blobDir = join(dir, "blob");
  await mkdir(blobDir, { recursive: true });
  const base = persistenceBaseName(target);

  if (text.length > 0) {
    await writeFile(join(dir, `${base}.txt`), text, "utf8");
  }
  await Promise.all(
    images.map((image, index) => {
      const extension = imageExtension(image.mediaType);
      return writeFile(join(blobDir, `${base}-image-${index + 1}.${extension}`), image.bytes);
    }),
  );
}

/**
 * Compose the system-prompt hint that tells the model where MCP outputs are
 * persisted and how to read them back. Returns an empty string for Stage-like
 * callers that should not advertise MCP. Appended by the prompt builders and
 * re-appended by `refreshLiveSystemPrompt`, mirroring the Skill catalog block.
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
