import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { cloneProviderStateEnvelope } from "../../providers/shared/state";
import type { ImageDetail, VesicleImageAttachment, VesicleMessage } from "../../providers/shared/types";

export const maxImageAttachmentBytes = 20 * 1024 * 1024;

/**
 * Pre-flight the shared attachment cap on an observed file size so callers
 * that would otherwise buffer whole files (view_image paths) can reject
 * oversized images before reading them into memory. The in-bytes check inside
 * `ingestImageBytes` remains the enforcement backstop.
 */
export function assertImageAttachmentSize(sizeBytes: number): void {
  if (sizeBytes > maxImageAttachmentBytes) {
    throw new Error(`Image attachment exceeds the ${formatImageAttachmentBytes(maxImageAttachmentBytes)} limit.`);
  }
}

export type SupportedImageMime = VesicleImageAttachment["mediaType"];

export async function ingestImageBytes(
  rootDir: string,
  bytes: Uint8Array,
  options: {
    source: VesicleImageAttachment["source"];
    filename?: string;
    sourcePath?: string;
    detail?: ImageDetail;
    expectedMediaType?: SupportedImageMime;
  },
): Promise<VesicleImageAttachment> {
  if (bytes.byteLength === 0) throw new Error("Image attachment is empty.");
  if (bytes.byteLength > maxImageAttachmentBytes) {
    throw new Error(`Image attachment exceeds the ${formatImageAttachmentBytes(maxImageAttachmentBytes)} limit.`);
  }

  const mediaType = detectImageMediaType(bytes);
  if (!mediaType) throw new Error("Unsupported image format. Use PNG, JPEG, GIF, or WebP.");
  if (options.expectedMediaType && mediaType !== options.expectedMediaType) {
    throw new Error(`Image attachment MIME mismatch: declared ${options.expectedMediaType}, detected ${mediaType}.`);
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const extension = extensionForMime(mediaType);
  const attachmentPath = `.vesicle/attachments/${sha256}.${extension}`;
  const absolutePath = resolve(rootDir, attachmentPath);
  await mkdir(join(rootDir, ".vesicle", "attachments"), { recursive: true });
  await writeFile(absolutePath, bytes, { flag: "wx" }).catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") return;
    throw error;
  });

  return {
    id: `img_${sha256.slice(0, 12)}`,
    path: attachmentPath,
    mediaType,
    bytes: bytes.byteLength,
    sha256,
    source: options.source,
    ...(options.filename ? { filename: basename(options.filename) } : {}),
    ...(options.sourcePath ? { sourcePath: options.sourcePath } : {}),
    ...(options.detail ? { detail: options.detail } : {}),
  };
}

export async function ingestImageFile(
  rootDir: string,
  absolutePath: string,
  options: {
    source: VesicleImageAttachment["source"];
    filename?: string;
    sourcePath?: string;
    detail?: ImageDetail;
    expectedMediaType?: SupportedImageMime;
  },
): Promise<VesicleImageAttachment> {
  // Pre-flight the cap on the observed size so a multi-gigabyte path is
  // rejected before the whole file is buffered.
  const info = await stat(absolutePath).catch(() => undefined);
  if (info?.isFile()) assertImageAttachmentSize(info.size);
  return ingestImageBytes(rootDir, await readFile(absolutePath), {
    ...options,
    filename: options.filename ?? basename(absolutePath),
  });
}

export async function materializeMessageImages(
  rootDir: string,
  images: VesicleImageAttachment[] | undefined,
): Promise<VesicleImageAttachment[] | undefined> {
  if (!images || images.length === 0) return undefined;
  return Promise.all(images.map(async (image) => {
    if (image.data) return { ...image };
    const absolutePath = resolveAttachmentPath(rootDir, image.path);
    const bytes = await readFile(absolutePath);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== image.sha256) throw new Error(`Image attachment changed on disk: ${image.id}.`);
    if (detectImageMediaType(bytes) !== image.mediaType) {
      throw new Error(`Image attachment MIME changed on disk: ${image.id}.`);
    }
    return { ...image, data: Buffer.from(bytes).toString("base64") };
  }));
}

export async function prepareProviderMessages(
  rootDir: string,
  messages: VesicleMessage[],
  visionEnabled: boolean,
): Promise<VesicleMessage[]> {
  const hasImages = messages.some((message) => (message.images?.length ?? 0) > 0);
  if (hasImages && !visionEnabled) {
    throw new Error("The selected model does not declare capabilities.vision: true; image attachments were not sent.");
  }
  return Promise.all(messages.map(async (message) => {
    const images = await materializeMessageImages(rootDir, message.images);
    return {
      ...message,
      ...(message.providerState ? { providerState: cloneProviderStateEnvelope(message.providerState) } : {}),
      ...(images ? { images } : {}),
    };
  }));
}

export function persistedImageAttachments(
  images: VesicleImageAttachment[] | undefined,
): VesicleImageAttachment[] | undefined {
  if (!images || images.length === 0) return undefined;
  return images.map(({ data: _data, ...image }) => ({ ...image }));
}

export function parseImageAttachments(value: unknown): VesicleImageAttachment[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const parsed = value.filter(isImageAttachment).map(({ data: _data, ...image }) => ({ ...image }));
  return parsed.length > 0 ? parsed : undefined;
}

export function detectImageMediaType(bytes: Uint8Array): SupportedImageMime | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  const header = Buffer.from(bytes.subarray(0, 12)).toString("ascii");
  if (header.startsWith("GIF87a") || header.startsWith("GIF89a")) return "image/gif";
  if (header.startsWith("RIFF") && header.slice(8, 12) === "WEBP") return "image/webp";
  return undefined;
}

function resolveAttachmentPath(rootDir: string, attachmentPath: string): string {
  const attachmentRoot = resolve(rootDir, ".vesicle", "attachments");
  const candidate = resolve(rootDir, attachmentPath);
  const rel = relative(attachmentRoot, candidate);
  if (!rel || rel.startsWith("..") || rel.includes(`${sep}..${sep}`)) {
    throw new Error(`Unsafe image attachment path: ${attachmentPath}.`);
  }
  return candidate;
}

function isImageAttachment(value: unknown): value is VesicleImageAttachment {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const image = value as Partial<VesicleImageAttachment>;
  return typeof image.id === "string"
    && typeof image.path === "string"
    && typeof image.bytes === "number"
    && typeof image.sha256 === "string"
    && (image.source === "clipboard" || image.source === "project" || image.source === "mcp")
    && ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(image.mediaType ?? "");
}

function startsWith(bytes: Uint8Array, prefix: number[]): boolean {
  return prefix.every((byte, index) => bytes[index] === byte);
}

function extensionForMime(mime: SupportedImageMime): string {
  if (mime === "image/jpeg") return "jpg";
  return mime.slice("image/".length);
}

export function formatImageAttachmentBytes(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)} MiB`;
}
