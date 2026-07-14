import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AssetResolverOptions } from "../runtime/assets";
import { AssetResolver, bundledHarnessLayout } from "../runtime/assets";
import type { HarnessRuntimeContext, HarnessRuntimeIdentity } from "./driver";
import { harnessPacksDirectory } from "./install";
import { createHarnessRuntimeContext } from "./runtime";
import type { VerifiedHarnessPack } from "./types";
import {
  assertHarnessPackCompatible,
  verifyBundledHarnessPack,
  verifyHarnessPack,
  type HarnessVerificationOptions,
} from "./verify";

export type HarnessProjectLock = HarnessRuntimeIdentity & {
  schema: "prism-vesicle-assets-lock/v1";
};

export type ProjectHarnessRuntime = {
  selection: "managed" | "bundled";
  lock: HarnessProjectLock;
  pack: VerifiedHarnessPack;
  assets: AssetResolver;
  harness: HarnessRuntimeContext;
};

export type HarnessActivationOptions = HarnessVerificationOptions & AssetResolverOptions;

const lockFields = [
  "schema", "packId", "packVersion", "sourceCommit", "manifestSha256",
  "adapterId", "adapterVersion", "adapterHash",
] as const;
const identityFields = lockFields.filter((field) => field !== "schema");
const hashPattern = /^[a-f0-9]{64}$/;
const identifierPattern = /^[a-z][a-z0-9-]*$/;
const semverPattern = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

export function projectHarnessLockPath(projectRoot = process.cwd()): string {
  return join(projectRoot, ".vesicle", "assets.lock.json");
}

export function installedHarnessDirectory(
  packId: string,
  packVersion: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  assertPattern(packId, identifierPattern, "pack id");
  assertPattern(packVersion, semverPattern, "pack version");
  return join(harnessPacksDirectory(env), packId, packVersion);
}

export async function loadProjectHarnessLock(projectRoot = process.cwd()): Promise<HarnessProjectLock | undefined> {
  const path = projectHarnessLockPath(projectRoot);
  const source = await readFile(path, "utf8").catch((error: unknown) => {
    if (errorCode(error) === "ENOENT") return undefined;
    throw new Error(`Cannot read project Harness lock: ${errorMessage(error)}`);
  });
  if (source === undefined) return undefined;
  try {
    return parseHarnessProjectLock(JSON.parse(source));
  } catch (error) {
    throw new Error(`Project Harness lock is invalid: ${errorMessage(error)}`);
  }
}

export function parseHarnessProjectLock(value: unknown): HarnessProjectLock {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("lock must be an object");
  const raw = value as Record<string, unknown>;
  const extra = Object.keys(raw).filter((field) => !lockFields.includes(field as typeof lockFields[number]));
  const missing = lockFields.filter((field) => !Object.hasOwn(raw, field));
  if (extra.length > 0) throw new Error(`unsupported field(s): ${extra.join(", ")}`);
  if (missing.length > 0) throw new Error(`missing field(s): ${missing.join(", ")}`);
  if (raw.schema !== "prism-vesicle-assets-lock/v1") throw new Error("unsupported schema");
  return {
    schema: raw.schema,
    packId: readPattern(raw.packId, identifierPattern, "packId"),
    packVersion: readPattern(raw.packVersion, semverPattern, "packVersion"),
    sourceCommit: readString(raw.sourceCommit, "sourceCommit"),
    manifestSha256: readPattern(raw.manifestSha256, hashPattern, "manifestSha256"),
    adapterId: readString(raw.adapterId, "adapterId"),
    adapterVersion: readPattern(raw.adapterVersion, semverPattern, "adapterVersion"),
    adapterHash: readPattern(raw.adapterHash, hashPattern, "adapterHash"),
  };
}

export function parseHarnessRuntimeIdentity(value: unknown): HarnessRuntimeIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("identity must be an object");
  const raw = value as Record<string, unknown>;
  const extra = Object.keys(raw).filter((field) => !identityFields.includes(field as typeof identityFields[number]));
  const missing = identityFields.filter((field) => !Object.hasOwn(raw, field));
  if (extra.length > 0 || missing.length > 0) throw new Error("identity fields are invalid");
  return {
    packId: readPattern(raw.packId, identifierPattern, "packId"),
    packVersion: readPattern(raw.packVersion, semverPattern, "packVersion"),
    sourceCommit: readString(raw.sourceCommit, "sourceCommit"),
    manifestSha256: readPattern(raw.manifestSha256, hashPattern, "manifestSha256"),
    adapterId: readString(raw.adapterId, "adapterId"),
    adapterVersion: readPattern(raw.adapterVersion, semverPattern, "adapterVersion"),
    adapterHash: readPattern(raw.adapterHash, hashPattern, "adapterHash"),
  };
}

export async function activateInstalledHarness(
  projectRoot: string,
  packId: string,
  packVersion: string,
  options: HarnessActivationOptions = {},
): Promise<ProjectHarnessRuntime> {
  const directory = installedHarnessDirectory(packId, packVersion, options.env);
  const pack = await verifyHarnessPack(directory, options);
  assertHarnessPackCompatible(pack);
  const lock = lockFromPack(pack);
  const runtime = await projectRuntime(projectRoot, lock, pack, options, "managed");
  await writeProjectHarnessLock(projectRoot, lock);
  return runtime;
}

export async function resolveProjectHarnessRuntime(
  projectRoot = process.cwd(),
  options: HarnessActivationOptions = {},
): Promise<ProjectHarnessRuntime | undefined> {
  const lock = await loadProjectHarnessLock(projectRoot);
  if (!lock) return resolveBundledHarnessRuntime(projectRoot, options);
  const directory = installedHarnessDirectory(lock.packId, lock.packVersion, options.env);
  const pack = await verifyHarnessPack(directory, options);
  assertHarnessPackCompatible(pack);
  assertLockMatchesPack(lock, pack);
  return projectRuntime(projectRoot, lock, pack, options, "managed");
}

export async function resolveBundledHarnessRuntime(
  projectRoot = process.cwd(),
  options: HarnessActivationOptions = {},
): Promise<ProjectHarnessRuntime | undefined> {
  if (options.bundledDirectory && !options.hostAssetsDirectory) return undefined;
  const layout = bundledHarnessLayout(options.executablePath);
  if (!layout) return undefined;
  const resolvedOptions = { ...options, hostAssetsDirectory: layout.hostAssetsDirectory };
  const pack = await verifyBundledHarnessPack(layout, resolvedOptions);
  assertHarnessPackCompatible(pack);
  const lock = lockFromPack(pack);
  return projectRuntime(projectRoot, lock, pack, resolvedOptions, "bundled");
}

export async function rollbackProjectHarness(projectRoot = process.cwd()): Promise<HarnessProjectLock> {
  const lock = await loadProjectHarnessLock(projectRoot);
  if (!lock) throw new Error("Project does not have an active managed Harness baseline.");
  const path = projectHarnessLockPath(projectRoot);
  const retired = `${path}.rollback-${randomUUID()}`;
  await rename(path, retired);
  await rm(retired, { force: true }).catch(() => undefined);
  return lock;
}

export function assertSessionHarnessIdentity(
  recorded: HarnessRuntimeIdentity | undefined,
  current: HarnessRuntimeIdentity | undefined,
): void {
  if (!recorded && !current) return;
  if (!recorded || !current || lockIdentityKey(recorded) !== lockIdentityKey(current)) {
    throw new Error("Session Harness identity does not match the active verified project baseline.");
  }
}

function projectRuntime(
  projectRoot: string,
  lock: HarnessProjectLock,
  pack: VerifiedHarnessPack,
  options: HarnessActivationOptions,
  selection: "managed" | "bundled",
): Promise<ProjectHarnessRuntime> {
  const assets = new AssetResolver(projectRoot, {
    ...options,
    managedBaseline: {
      assetsDirectory: join(pack.directory, "assets"),
      externalHostAssets: pack.manifest.externalHostAssets,
      source: selection,
    },
  });
  return createHarnessRuntimeContext(pack).then((harness) => ({ selection, lock, pack, assets, harness }));
}

function lockFromPack(pack: VerifiedHarnessPack): HarnessProjectLock {
  return {
    schema: "prism-vesicle-assets-lock/v1",
    packId: pack.manifest.id,
    packVersion: pack.manifest.version,
    sourceCommit: pack.manifest.sourceCommit,
    manifestSha256: pack.manifestSha256,
    adapterId: pack.manifest.driver.adapterId,
    adapterVersion: pack.manifest.driver.adapterVersion,
    adapterHash: pack.manifest.driver.adapterHash,
  };
}

function assertLockMatchesPack(lock: HarnessProjectLock, pack: VerifiedHarnessPack): void {
  if (lockIdentityKey(lock) !== lockIdentityKey(lockFromPack(pack))) {
    throw new Error("Installed Harness identity does not match the project lock.");
  }
}

function lockIdentityKey(identity: HarnessRuntimeIdentity): string {
  return [
    identity.packId, identity.packVersion, identity.sourceCommit, identity.manifestSha256,
    identity.adapterId, identity.adapterVersion, identity.adapterHash,
  ].join("\0");
}

async function writeProjectHarnessLock(projectRoot: string, lock: HarnessProjectLock): Promise<void> {
  const path = projectHarnessLockPath(projectRoot);
  await mkdir(dirname(path), { recursive: true });
  const staging = `${path}.staging-${randomUUID()}`;
  try {
    await writeFile(staging, `${JSON.stringify(lock, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(staging, path);
  } finally {
    await rm(staging, { force: true });
  }
}

function readPattern(value: unknown, pattern: RegExp, label: string): string {
  const parsed = readString(value, label);
  if (!pattern.test(parsed)) throw new Error(`${label} is invalid`);
  return parsed;
}

function readString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function assertPattern(value: string, pattern: RegExp, label: string): void {
  if (!pattern.test(value)) throw new Error(`Harness ${label} is invalid.`);
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
