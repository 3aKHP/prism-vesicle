import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { harnessQualityModes, type HarnessDriverIdentity, type HarnessManifest, type HarnessQualityMode, type HarnessRuleModule } from "./types";

const identifierPattern = /^[a-z][a-z0-9-]*$/;
const semverPattern = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const hashPattern = /^[a-f0-9]{64}$/;
const qualityModeSet = new Set<string>(harnessQualityModes);

const manifestFields = [
  "schema", "id", "version", "sourceRepository", "sourceCommit", "sourceState",
  "harnessConfigHash", "compilerHash", "requiredCapabilities", "externalHostAssets",
  "driver", "ruleModules", "profileBindings", "agentProfileBindings", "promptBindings",
  "agentPromptBindings", "qualityBindings", "agentQualityBindings", "assets",
] as const;

const driverFields = [
  "contract", "contractHash", "contractSourceHash", "adapter", "adapterHash",
  "adapterSourceHash", "adapterId", "adapterVersion", "targetHost",
] as const;

export async function loadHarnessManifest(
  directory: string,
  manifestFileName: "manifest.json" | "harness-manifest.json" = "manifest.json",
): Promise<{ manifest: HarnessManifest; source: string; path: string }> {
  const path = join(directory, manifestFileName);
  const source = await readFile(path, "utf8").catch((error: unknown) => {
    throw new Error(`Cannot read Harness manifest at ${path}: ${errorMessage(error)}`);
  });
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(`Harness manifest is not valid JSON: ${errorMessage(error)}`);
  }
  return { manifest: parseHarnessManifest(value), source, path };
}

export function parseHarnessManifest(value: unknown): HarnessManifest {
  const raw = readObject(value, "Harness manifest");
  assertExactFields(raw, manifestFields, "Harness manifest");
  const schema = readString(raw.schema, "schema");
  if (schema !== "prism-harness-pack/v1") throw new Error(`Unsupported Harness manifest schema "${schema}".`);
  const sourceState = readString(raw.sourceState, "sourceState");
  if (sourceState !== "clean" && sourceState !== "dirty") {
    throw new Error('Harness manifest field "sourceState" must be clean or dirty.');
  }

  return {
    schema,
    id: readPattern(raw.id, "id", identifierPattern),
    version: readPattern(raw.version, "version", semverPattern),
    sourceRepository: readString(raw.sourceRepository, "sourceRepository"),
    sourceCommit: readString(raw.sourceCommit, "sourceCommit"),
    sourceState,
    harnessConfigHash: readHash(raw.harnessConfigHash, "harnessConfigHash"),
    compilerHash: readHash(raw.compilerHash, "compilerHash"),
    requiredCapabilities: readUniqueStringList(raw.requiredCapabilities, "requiredCapabilities"),
    externalHostAssets: readAssetPathList(raw.externalHostAssets, "externalHostAssets"),
    driver: readDriver(raw.driver),
    ruleModules: readRuleModules(raw.ruleModules),
    profileBindings: readPathMap(raw.profileBindings, "profileBindings"),
    agentProfileBindings: readPathMap(raw.agentProfileBindings, "agentProfileBindings"),
    promptBindings: readPathListMap(raw.promptBindings, "promptBindings"),
    agentPromptBindings: readPathListMap(raw.agentPromptBindings, "agentPromptBindings"),
    qualityBindings: readQualityMap(raw.qualityBindings, "qualityBindings"),
    agentQualityBindings: readQualityMap(raw.agentQualityBindings, "agentQualityBindings"),
    assets: readHashMap(raw.assets, "assets"),
  };
}

export function assertHarnessAssetPath(value: string, label = "asset path"): string {
  if (!value.startsWith("assets/") || value.includes("\\") || value.includes("\0")) {
    throw new Error(`Harness ${label} must be a logical assets/... path: ${value}.`);
  }
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === "..") || posix.normalize(value) !== value) {
    throw new Error(`Harness ${label} is unsafe: ${value}.`);
  }
  return value;
}

function readDriver(value: unknown): HarnessDriverIdentity {
  const raw = readObject(value, "driver");
  assertExactFields(raw, driverFields, "driver");
  return {
    contract: assertHarnessAssetPath(readString(raw.contract, "driver.contract"), "driver.contract"),
    contractHash: readHash(raw.contractHash, "driver.contractHash"),
    contractSourceHash: readHash(raw.contractSourceHash, "driver.contractSourceHash"),
    adapter: assertHarnessAssetPath(readString(raw.adapter, "driver.adapter"), "driver.adapter"),
    adapterHash: readHash(raw.adapterHash, "driver.adapterHash"),
    adapterSourceHash: readHash(raw.adapterSourceHash, "driver.adapterSourceHash"),
    adapterId: readString(raw.adapterId, "driver.adapterId"),
    adapterVersion: readPattern(raw.adapterVersion, "driver.adapterVersion", semverPattern),
    targetHost: readString(raw.targetHost, "driver.targetHost"),
  };
}

function readRuleModules(value: unknown): HarnessRuleModule[] {
  if (!Array.isArray(value)) throw new Error('Harness manifest field "ruleModules" must be a list.');
  const ids = new Set<string>();
  return value.map((entry, index) => {
    const raw = readObject(entry, `ruleModules[${index}]`);
    assertExactFields(raw, ["id", "manifest"], `ruleModules[${index}]`);
    const id = readString(raw.id, `ruleModules[${index}].id`);
    if (ids.has(id)) throw new Error(`Harness manifest contains duplicate rule module "${id}".`);
    ids.add(id);
    return {
      id,
      manifest: assertHarnessAssetPath(readString(raw.manifest, `ruleModules[${index}].manifest`), `ruleModules[${index}].manifest`),
    };
  });
}

function readPathMap(value: unknown, label: string): Record<string, string> {
  const raw = readObject(value, label);
  return Object.fromEntries(Object.entries(raw).map(([key, path]) => [
    key,
    assertHarnessAssetPath(readString(path, `${label}.${key}`), `${label}.${key}`),
  ]));
}

function readPathListMap(value: unknown, label: string): Record<string, string[]> {
  const raw = readObject(value, label);
  return Object.fromEntries(Object.entries(raw).map(([key, paths]) => [
    key,
    readAssetPathList(paths, `${label}.${key}`),
  ]));
}

function readQualityMap(value: unknown, label: string): Record<string, Record<string, HarnessQualityMode>> {
  const raw = readObject(value, label);
  return Object.fromEntries(Object.entries(raw).map(([owner, bindings]) => {
    const bindingMap = readObject(bindings, `${label}.${owner}`);
    return [owner, Object.fromEntries(Object.entries(bindingMap).map(([module, mode]) => {
      const parsed = readString(mode, `${label}.${owner}.${module}`);
      if (!qualityModeSet.has(parsed)) throw new Error(`Unknown Harness quality mode "${parsed}" at ${label}.${owner}.${module}.`);
      return [module, parsed as HarnessQualityMode];
    }))];
  }));
}

function readHashMap(value: unknown, label: string): Record<string, string> {
  const raw = readObject(value, label);
  if (Object.keys(raw).length === 0) throw new Error(`Harness manifest field "${label}" must not be empty.`);
  return Object.fromEntries(Object.entries(raw).map(([path, hash]) => [
    assertHarnessAssetPath(path, `${label} key`),
    readHash(hash, `${label}.${path}`),
  ]));
}

function readAssetPathList(value: unknown, label: string): string[] {
  return readUniqueStringList(value, label).map((path) => assertHarnessAssetPath(path, label));
}

function readUniqueStringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`Harness manifest field "${label}" must be a list.`);
  const result = value.map((item, index) => readString(item, `${label}[${index}]`));
  if (new Set(result).size !== result.length) throw new Error(`Harness manifest field "${label}" must contain unique values.`);
  return result;
}

function readHash(value: unknown, label: string): string {
  return readPattern(value, label, hashPattern);
}

function readPattern(value: unknown, label: string, pattern: RegExp): string {
  const parsed = readString(value, label);
  if (!pattern.test(parsed)) throw new Error(`Harness manifest field "${label}" has an invalid value.`);
  return parsed;
}

function readString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`Harness manifest field "${label}" must be a non-empty string.`);
  return value;
}

function readObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Harness manifest field "${label}" must be an object.`);
  return value as Record<string, unknown>;
}

function assertExactFields(raw: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  const extra = Object.keys(raw).filter((key) => !allowedSet.has(key));
  const missing = allowed.filter((key) => !Object.hasOwn(raw, key));
  if (extra.length > 0) throw new Error(`${label} contains unsupported field(s): ${extra.join(", ")}.`);
  if (missing.length > 0) throw new Error(`${label} is missing required field(s): ${missing.join(", ")}.`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
