import type { VesicleImageAttachment } from "../providers/shared/types";
import {
  detectImageMediaType,
  formatImageAttachmentBytes,
  ingestImageBytes,
  maxImageAttachmentBytes,
  type SupportedImageMime,
} from "../core/attachments/store";
import type { McpToolCallResult } from "./types";
import { sanitizeToolName } from "./types";

export type McpResultDeliveryContext = {
  rootDir: string;
  visionEnabled: boolean;
  serverId: string;
  toolName: string;
  signal?: AbortSignal;
};

export type DeliveredMcpToolResult = {
  content: string;
  images?: VesicleImageAttachment[];
  imageCount: number;
  omittedContentCount: number;
};

type ImageOmissionReason =
  | "tool-error"
  | "vision-disabled"
  | "unsupported-mime"
  | "invalid-base64"
  | "over-budget"
  | "mime-mismatch"
  | "attachment-write-failed";

const supportedImageMimes = new Set<SupportedImageMime>([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
const maxMcpImageLabelChars = 128;

export async function deliverMcpToolResult(
  result: McpToolCallResult,
  context: McpResultDeliveryContext,
): Promise<DeliveredMcpToolResult> {
  throwIfAborted(context.signal);
  const images: VesicleImageAttachment[] = [];
  const omissions = new Map<ImageOmissionReason, number>();
  const notices: string[] = [];

  if (result.isError) {
    addOmission(omissions, "tool-error", result.images.length);
  } else if (!context.visionEnabled) {
    addOmission(omissions, "vision-disabled", result.images.length);
  } else {
    for (const candidate of result.images) {
      throwIfAborted(context.signal);
      const mediaType = supportedImageMime(candidate.mimeType);
      if (!mediaType) {
        addOmission(omissions, "unsupported-mime");
        continue;
      }
      const decoded = decodeInlineBase64(candidate.data);
      if (!decoded.ok) {
        addOmission(omissions, decoded.reason);
        continue;
      }
      const detected = detectImageMediaType(decoded.bytes);
      if (!detected || detected !== mediaType) {
        addOmission(omissions, "mime-mismatch");
        continue;
      }
      throwIfAborted(context.signal);
      try {
        const image = await ingestImageBytes(context.rootDir, decoded.bytes, {
          source: "mcp",
          filename: imageLabel(context, candidate.contentIndex, mediaType),
          expectedMediaType: mediaType,
        });
        throwIfAborted(context.signal);
        images.push(image);
      } catch (error) {
        if (context.signal?.aborted) throw context.signal.reason ?? error;
        addOmission(omissions, "attachment-write-failed");
      }
    }
  }

  const diagnosticCount = result.diagnostics.length;
  if (diagnosticCount > 0) {
    notices.push(`MCP result omitted ${formatCount(diagnosticCount, "malformed or unknown content item")}.`);
  }
  const deferredCounts = countDeferredKinds(result);
  if (deferredCounts.total > 0) {
    const descriptions = [
      deferredCounts.audio > 0 ? formatCount(deferredCounts.audio, "audio item") : "",
      deferredCounts.resource > 0 ? formatCount(deferredCounts.resource, "resource item") : "",
      deferredCounts.link > 0 ? formatCount(deferredCounts.link, "link item") : "",
    ].filter(Boolean);
    notices.push(`MCP result omitted unsupported content: ${descriptions.join(", ")}.`);
  }
  for (const [reason, count] of omissions) {
    if (count > 0) notices.push(imageOmissionNotice(reason, count));
  }

  const safeText = result.text.join("\n").trim();
  const baseContent = safeText
    || (result.structuredContent !== undefined ? "MCP tool returned structured content." : "")
    || (images.length > 0 ? `MCP tool returned ${formatCount(images.length, "image")}.` : "")
    || (result.isError
      ? "MCP tool returned an error with no displayable text."
      : "MCP tool returned no displayable content.");
  const omittedContentCount = diagnosticCount + deferredCounts.total
    + [...omissions.values()].reduce((sum, count) => sum + count, 0);
  return {
    content: [baseContent, ...notices].join("\n"),
    ...(images.length > 0 ? { images } : {}),
    imageCount: images.length,
    omittedContentCount,
  };
}

function decodeInlineBase64(
  data: string,
): { ok: true; bytes: Uint8Array } | { ok: false; reason: "invalid-base64" | "over-budget" } {
  if (data.length === 0 || data.length % 4 !== 0) {
    return { ok: false, reason: "invalid-base64" };
  }
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  const body = data.slice(0, data.length - padding);
  if (body.includes("=") || padding > 2 || /[^A-Za-z0-9+/]/.test(body)) {
    return { ok: false, reason: "invalid-base64" };
  }
  const decodedBytes = (data.length / 4) * 3 - padding;
  if (decodedBytes > maxImageAttachmentBytes) return { ok: false, reason: "over-budget" };
  const bytes = Buffer.from(data, "base64");
  if (bytes.toString("base64") !== data) return { ok: false, reason: "invalid-base64" };
  return { ok: true, bytes };
}

function supportedImageMime(value: string): SupportedImageMime | undefined {
  const normalized = value.trim().toLowerCase() as SupportedImageMime;
  return supportedImageMimes.has(normalized) ? normalized : undefined;
}

function countDeferredKinds(result: McpToolCallResult): {
  audio: number;
  resource: number;
  link: number;
  total: number;
} {
  let audio = 0;
  let resource = 0;
  let link = 0;
  for (const candidate of result.deferred) {
    if (candidate.kind === "audio") audio += 1;
    else if (candidate.kind === "resource") resource += 1;
    else link += 1;
  }
  return { audio, resource, link, total: audio + resource + link };
}

function addOmission(
  omissions: Map<ImageOmissionReason, number>,
  reason: ImageOmissionReason,
  count = 1,
): void {
  if (count > 0) omissions.set(reason, (omissions.get(reason) ?? 0) + count);
}

function imageOmissionNotice(reason: ImageOmissionReason, count: number): string {
  const cause: Record<ImageOmissionReason, string> = {
    "tool-error": "the tool returned an error",
    "vision-disabled": "the selected model does not support vision",
    "unsupported-mime": "the declared MIME type is unsupported",
    "invalid-base64": "the inline data is not strict base64",
    "over-budget": `the decoded data exceeds the ${formatImageAttachmentBytes(maxImageAttachmentBytes)} limit`,
    "mime-mismatch": "the declared MIME type does not match the image bytes",
    "attachment-write-failed": "the attachment could not be stored",
  };
  return `MCP result omitted ${formatCount(count, "image")}: ${cause[reason]}.`;
}

function imageLabel(context: McpResultDeliveryContext, contentIndex: number, mediaType: SupportedImageMime): string {
  const extension = mediaType === "image/jpeg" ? "jpg" : mediaType.slice("image/".length);
  const suffix = `-image-${contentIndex + 1}.${extension}`;
  const base = `${sanitizeToolName(context.serverId)}-${sanitizeToolName(context.toolName)}`;
  return `${base.slice(0, maxMcpImageLabelChars - suffix.length)}${suffix}`;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

function formatCount(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}
