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

type IconBuildManifest = {
  schema: string;
  renderer: string;
  sources: Record<string, string>;
  frames: Array<{ size: number; source: string; sha256: string }>;
  wizard: { size: number; source: string; sha256: string };
  outputs: { icoSha256: string; wizardSha256: string };
};

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

async function checkTrackedOutputs(): Promise<string[]> {
  const drift: string[] = [];
  const manifest = await Bun.file(BUILD_MANIFEST_PATH).json().catch(() => undefined) as IconBuildManifest | undefined;
  if (!manifest) return ["missing or malformed icon-build.json"];
  if (manifest.schema !== WINDOWS_ICON_SCHEMA) drift.push("manifest schema");
  if (manifest.renderer !== "@resvg/resvg-js@2.6.2") drift.push("renderer version");
  const expectedFrames = WINDOWS_ICON_FRAMES.map(({ size, source }) => ({ size, source }));
  const recordedFrames = manifest.frames.map(({ size, source }) => ({ size, source }));
  if (JSON.stringify(recordedFrames) !== JSON.stringify(expectedFrames)) drift.push("frame inventory");
  if (manifest.wizard.size !== WINDOWS_WIZARD_SIZE || manifest.wizard.source !== WINDOWS_ICON_SOURCES.mark) {
    drift.push("wizard inventory");
  }
  if (manifest.wizard.sha256 !== manifest.frames.find((frame) => frame.size === WINDOWS_WIZARD_SIZE && frame.source === "mark")?.sha256) {
    drift.push("wizard frame hash");
  }
  if (manifest.frames.some((frame) => !/^[0-9a-f]{64}$/.test(frame.sha256))) drift.push("frame hashes");
  for (const relativePath of Object.values(WINDOWS_ICON_SOURCES)) {
    const actual = await sourceHash(resolve(ROOT, relativePath));
    if (manifest.sources[relativePath] !== actual) drift.push(`source ${relativePath}`);
  }
  const ico = await readFile(ICO_PATH).catch(() => undefined);
  const wizard = await readFile(WIZARD_PATH).catch(() => undefined);
  if (!ico || hash(ico) !== manifest.outputs.icoSha256) drift.push("prism-vesicle.ico");
  if (!wizard || hash(wizard) !== manifest.outputs.wizardSha256 || hash(wizard) !== manifest.wizard.sha256) {
    drift.push("prism-vesicle-wizard.png");
  }
  return drift;
}

export async function buildWindowsIcons(checkOnly = false): Promise<void> {
  if (checkOnly) {
    const drift = await checkTrackedOutputs();
    if (drift.length === 0) {
      console.log("Windows brand icon outputs are deterministic and in sync.");
      return;
    }
    throw new Error(`Windows brand icon outputs are missing or out of sync (${drift.join(", ")}). Run bun run build:windows-icon.`);
  }
  const outputs = await buildOutputs();
  await mkdir(dirname(ICO_PATH), { recursive: true });
  await writeFile(ICO_PATH, outputs.ico);
  await writeFile(WIZARD_PATH, outputs.wizard);
  await writeFile(BUILD_MANIFEST_PATH, outputs.manifest, "utf8");
  console.log(`Generated ${ICO_PATH}, ${WIZARD_PATH}, and ${BUILD_MANIFEST_PATH}.`);
}

export async function verifyWindowsIconRegeneration(): Promise<boolean> {
  const outputs = await buildOutputs();
  const checks = await Promise.all([
    checkFile(ICO_PATH, outputs.ico),
    checkFile(WIZARD_PATH, outputs.wizard),
    checkFile(BUILD_MANIFEST_PATH, outputs.manifest),
  ]);
  return checks.every(Boolean);
}

if (import.meta.main) await buildWindowsIcons(process.argv.includes("--check"));
