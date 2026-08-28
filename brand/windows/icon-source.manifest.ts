import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export const WINDOWS_ICON_SOURCES = {
  mono: "brand/prism-vesicle-mono.svg",
  mark: "brand/prism-vesicle-mark.svg",
} as const;

export const WINDOWS_ICON_FRAMES = [
  { size: 16, source: "mono" },
  { size: 20, source: "mono" },
  { size: 24, source: "mono" },
  { size: 32, source: "mono" },
  { size: 40, source: "mono" },
  { size: 48, source: "mono" },
  { size: 64, source: "mark" },
  { size: 128, source: "mark" },
  { size: 256, source: "mark" },
] as const;

export const WINDOWS_WIZARD_SIZE = 256;
export const WINDOWS_ICON_SCHEMA = "prism-vesicle-windows-icon-v1";

export async function sourceHash(path: string): Promise<string> {
  const content = await readFile(path);
  return createHash("sha256").update(content).digest("hex");
}
