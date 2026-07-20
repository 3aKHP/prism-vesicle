import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import type { ImageDetail, VesicleImageAttachment } from "../../providers/shared/types";

export const maxImageAttachmentBytes = 5 * 1024 * 1024;

type SupportedImageMime = VesicleImageAttachment["mediaType"];

export async function ingestImageBytes(
  rootDir: string,
  bytes: Uint8Array,
  options: {
    source: VesicleImageAttachment["source"];
    filename?: string;
    sourcePath?: string;
    detail?: ImageDetail;
  },
): Promise<VesicleImageAttachment> {
  if (bytes.byteLength === 0) throw new Error("Image attachment is empty.");
  if (bytes.byteLength > maxImageAttachmentBytes) {
    throw new Error(`Image attachment exceeds the ${formatBytes(maxImageAttachmentBytes)} limit.`);
  }

  const mediaType = detectImageMediaType(bytes);
  if (!mediaType) throw new Error("Unsupported image format. Use PNG, JPEG, GIF, or WebP.");
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
  },
): Promise<VesicleImageAttachment> {
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
    && (image.source === "clipboard" || image.source === "project")
    && ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(image.mediaType ?? "");
}

function startsWith(bytes: Uint8Array, prefix: number[]): boolean {
  return prefix.every((byte, index) => bytes[index] === byte);
}

function extensionForMime(mime: SupportedImageMime): string {
  if (mime === "image/jpeg") return "jpg";
  return mime.slice("image/".length);
}

function formatBytes(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}
