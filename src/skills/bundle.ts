/**
 * Portable Skill bundle inspection and byte-exact staging.
 *
 * The single reusable seam shared by the immutable Skill Store (`store.ts`)
 * and the `skillify` draft publisher (`core/skills/draft-publisher.ts`). It
 * owns the portable format concerns that must never be duplicated: reading and
 * parsing `SKILL.md`, enumerating the complete bundle under the same path
 * guards used everywhere else, content-hashing every accepted file, computing
 * the deterministic bundle hash, deriving the content-addressed version, and
 * staging a byte-exact copy that is re-verified by hash.
 *
 * `computeBundleHash` is byte-compatible with every previously installed
 * snapshot; existing installed versions must not change. `installSnapshot` calls
 * this seam after refactoring so there is one hash/copy implementation.
 */

import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { SKILL_FILE_NAME } from "./loader";
import { enumerateSkillBundle } from "./paths";
import { parseSkillMarkdown } from "./parser";
import type { SkillDiagnostic } from "./types";

/** One file in a standard Skill bundle, with its content hash and size. */
export interface SkillBundleFile {
  path: string;
  sha256: string;
  bytes: number;
}

/**
 * Complete inspection of one Skill directory: the validated name, content and
 * bundle hashes, the content-addressed version the Store would use, the full
 * file inventory, and the non-blocking diagnostics accumulated during parsing
 * and enumeration. Blocking diagnostics and parse failures throw
 * `SkillBundleError` before this type is returned.
 */
export type InspectedSkillBundle = {
  name: string;
  bodySha256: string;
  bundleSha256: string;
  version: string;
  files: readonly SkillBundleFile[];
  diagnostics: readonly SkillDiagnostic[];
};

export type SkillBundleErrorCode = "bundle-unavailable" | "bundle-invalid";

/**
 * Structured failure thrown by bundle inspection when the source cannot be read
 * (`bundle-unavailable`) or when parsing, path safety, or bundle integrity fail
 * (`bundle-invalid`). Carries the diagnostics so callers at the CLI boundary
 * can map them to stable error codes without parsing message text.
 */
export class SkillBundleError extends Error {
  readonly diagnostics: readonly SkillDiagnostic[];
  constructor(
    readonly code: SkillBundleErrorCode,
    diagnostics: readonly SkillDiagnostic[],
    message: string,
  ) {
    super(message);
    this.name = "SkillBundleError";
    this.diagnostics = diagnostics;
  }
}

/**
 * Deterministic SHA-256 over a sorted `path\0sha256` inventory. The sort makes
 * the hash independent of directory enumeration order so identical bundles
 * always produce identical hashes. Byte-compatible with all prior installs.
 */
export function computeBundleHash(inventory: readonly SkillBundleFile[]): string {
  const payload = [...inventory]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((file) => `${file.path}\0${file.sha256}`)
    .join("\n");
  return createHash("sha256").update(payload).digest("hex");
}

/**
 * Inspect one Skill source directory: validate it is a real directory, read and
 * parse `SKILL.md`, enumerate the complete bundle under the shared path guards,
 * reject blocking diagnostics, hash every accepted file, and derive the
 * content-addressed version. Throws `SkillBundleError` on any structural,
 * parse, or blocking-diagnostic failure; returns the non-blocking diagnostics
 * alongside the hash and inventory on success.
 */
export async function inspectSkillBundle(sourceDirectory: string): Promise<InspectedSkillBundle> {
  const expectedName = basename(sourceDirectory);

  const rootInfo = await lstat(sourceDirectory).catch((error: unknown) => {
    throw new SkillBundleError("bundle-unavailable", [], `Cannot access skill source directory: ${errorMessage(error)}`);
  });
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new SkillBundleError("bundle-unavailable", [], "Skill source must be a real directory, not a file or symbolic link.");
  }

  const skillFile = join(sourceDirectory, SKILL_FILE_NAME);
  const raw = await readFile(skillFile).catch((error: unknown) => {
    throw new SkillBundleError("bundle-unavailable", [], `Cannot read ${SKILL_FILE_NAME}: ${errorMessage(error)}`);
  });
  const content = decodeUtf8(raw.subarray(stripBom(raw)));

  const parsed = parseSkillMarkdown(content, expectedName);
  if (!parsed.ok) {
    throw new SkillBundleError(
      "bundle-invalid",
      parsed.diagnostics,
      `Skill "${expectedName}" failed validation: ${parsed.diagnostics.map((diagnostic) => diagnostic.message).join(" ")}`,
    );
  }

  const bundle = await enumerateSkillBundle(sourceDirectory, SKILL_FILE_NAME);
  const diagnostics: SkillDiagnostic[] = [...parsed.diagnostics, ...bundle.diagnostics];
  const blocking = bundle.diagnostics.filter((diagnostic) => diagnostic.kind !== "resource-oversized");
  if (blocking.length > 0) {
    throw new SkillBundleError(
      "bundle-invalid",
      diagnostics,
      `Skill "${parsed.metadata.name}" cannot be stored: ${blocking.map((diagnostic) => diagnostic.message).join(" ")}`,
    );
  }

  const inventory = await hashFiles(sourceDirectory, bundle.files);
  const bundleSha256 = computeBundleHash(inventory);
  return {
    name: parsed.metadata.name,
    bodySha256: parsed.bodySha256,
    bundleSha256,
    version: `sha-${bundleSha256.slice(0, 12)}`,
    files: inventory,
    diagnostics,
  };
}

/**
 * Copy only the inspected inventory from `sourceDirectory` into
 * `destinationDirectory`, preserving ordinary file bytes, then re-hash the
 * destination and reject any drift from `expected.bundleSha256`. The
 * destination must not exist yet; the caller owns its lifetime and cleanup.
 */
export async function stageSkillBundle(
  sourceDirectory: string,
  destinationDirectory: string,
  expected: InspectedSkillBundle,
): Promise<void> {
  await copyBundleFiles(sourceDirectory, destinationDirectory, expected.files);
  const staged = await hashBundleDirectory(destinationDirectory);
  if (computeBundleHash(staged) !== expected.bundleSha256) {
    throw new SkillBundleError("bundle-invalid", [], "Skill snapshot verification failed after staging; refusing to install.");
  }
}

/** Enumerate and hash every file in a Skill bundle directory. */
export async function hashBundleDirectory(directory: string): Promise<SkillBundleFile[]> {
  const { files } = await enumerateSkillBundle(directory, SKILL_FILE_NAME);
  return hashFiles(directory, files);
}

// --- internal helpers ------------------------------------------------------

async function hashFiles(sourceDirectory: string, files: readonly { path: string }[]): Promise<SkillBundleFile[]> {
  const inventory: SkillBundleFile[] = [];
  for (const file of files) {
    const absolutePath = join(sourceDirectory, ...file.path.split("/"));
    const bytes = await readFile(absolutePath);
    inventory.push({ path: file.path, sha256: sha256(bytes), bytes: bytes.byteLength });
  }
  return inventory;
}

async function copyBundleFiles(
  sourceDirectory: string,
  destinationDirectory: string,
  inventory: readonly SkillBundleFile[],
): Promise<void> {
  await mkdir(destinationDirectory, { recursive: true });
  for (const file of inventory) {
    const target = join(destinationDirectory, ...file.path.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(sourceDirectory, ...file.path.split("/")), target);
  }
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function decodeUtf8(raw: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    throw new SkillBundleError("bundle-unavailable", [], `${SKILL_FILE_NAME} is not valid UTF-8.`);
  }
}

function stripBom(raw: Uint8Array): number {
  return raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf ? 3 : 0;
}

function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof (error as { code: unknown }).code === "string") {
    return (error as { code: string }).code;
  }
  return error instanceof Error ? error.message : String(error);
}
