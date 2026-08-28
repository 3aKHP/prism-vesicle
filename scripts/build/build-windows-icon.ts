import { Resvg } from "@resvg/resvg-js";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  sourceHash,
  WINDOWS_ICON_FRAMES,
  WINDOWS_ICON_SCHEMA,
  WINDOWS_ICON_SOURCES,
  WINDOWS_WIZARD_SIZE,
} from "../../brand/windows/icon-source.manifest";

const ROOT = resolve(import.meta.dir, "../..");
const OUTPUT_DIR = resolve(ROOT, "brand/windows");
const ICO_PATH = resolve(OUTPUT_DIR, "prism-vesicle.ico");
const WIZARD_PATH = resolve(OUTPUT_DIR, "prism-vesicle-wizard.png");
const BUILD_MANIFEST_PATH = resolve(OUTPUT_DIR, "icon-build.json");
const EMERALD = "#10b981";

type Frame = (typeof WINDOWS_ICON_FRAMES)[number];

function hash(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function renderSvg(source: string, size: number): Buffer {
  const normalized = source.replaceAll("currentColor", EMERALD);
  return new Resvg(normalized, {
    fitTo: { mode: "width", value: size },
    font: { loadSystemFonts: false },
  }).render().asPng();
}

function encodeIco(frames: Array<{ size: number; png: Buffer }>): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);
  const directory = Buffer.alloc(frames.length * 16);
  let offset = header.length + directory.length;
  const payloads: Buffer[] = [];
  for (const [index, frame] of frames.entries()) {
    const entry = index * 16;
    directory.writeUInt8(frame.size >= 256 ? 0 : frame.size, entry);
    directory.writeUInt8(frame.size >= 256 ? 0 : frame.size, entry + 1);
    directory.writeUInt8(0, entry + 2);
    directory.writeUInt8(0, entry + 3);
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(frame.png.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    payloads.push(frame.png);
    offset += frame.png.length;
  }
  return Buffer.concat([header, directory, ...payloads]);
}

async function buildOutputs(): Promise<{ ico: Buffer; wizard: Buffer; manifest: string }> {
  const sourceContents = new Map<string, string>();
  const sourceHashes: Record<string, string> = {};
  for (const [name, relativePath] of Object.entries(WINDOWS_ICON_SOURCES)) {
    const path = resolve(ROOT, relativePath);
    sourceContents.set(name, await readFile(path, "utf8"));
    sourceHashes[relativePath] = await sourceHash(path);
  }
  const frames = WINDOWS_ICON_FRAMES.map((frame: Frame) => ({
    size: frame.size,
    source: frame.source,
    png: renderSvg(sourceContents.get(frame.source)!, frame.size),
  }));
  const ico = encodeIco(frames);
  const wizard = renderSvg(sourceContents.get("mark")!, WINDOWS_WIZARD_SIZE);
  const manifest = JSON.stringify({
    schema: WINDOWS_ICON_SCHEMA,
    renderer: "@resvg/resvg-js@2.6.2",
    sources: sourceHashes,
    frames: frames.map(({ size, source, png }) => ({ size, source, sha256: hash(png) })),
    wizard: { size: WINDOWS_WIZARD_SIZE, source: WINDOWS_ICON_SOURCES.mark, sha256: hash(wizard) },
    outputs: { icoSha256: hash(ico), wizardSha256: hash(wizard) },
  }, null, 2) + "\n";
  return { ico, wizard, manifest };
}

async function checkFile(path: string, expected: Buffer | string): Promise<boolean> {
  const actual = await readFile(path).catch(() => undefined);
  if (!actual) return false;
  return Buffer.isBuffer(expected) ? actual.equals(expected) : actual.toString("utf8") === expected;
}

export async function buildWindowsIcons(checkOnly = false): Promise<void> {
  const outputs = await buildOutputs();
  if (checkOnly) {
    const checks = await Promise.all([
      checkFile(ICO_PATH, outputs.ico),
      checkFile(WIZARD_PATH, outputs.wizard),
      checkFile(BUILD_MANIFEST_PATH, outputs.manifest),
    ]);
    if (checks.every(Boolean)) {
      console.log("Windows brand icon outputs are deterministic and in sync.");
      return;
    }
    throw new Error("Windows brand icon outputs are missing or out of sync. Run bun run build:windows-icon.");
  }
  await mkdir(dirname(ICO_PATH), { recursive: true });
  await writeFile(ICO_PATH, outputs.ico);
  await writeFile(WIZARD_PATH, outputs.wizard);
  await writeFile(BUILD_MANIFEST_PATH, outputs.manifest, "utf8");
  console.log(`Generated ${ICO_PATH}, ${WIZARD_PATH}, and ${BUILD_MANIFEST_PATH}.`);
}

if (import.meta.main) await buildWindowsIcons(process.argv.includes("--check"));
