import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { assertChildToolDeclaration } from "../agents/tool-scope";
import { loadAgentProfile } from "../agents/profile";
import { resolveBuiltInTools } from "../agent-loop/tool-surface";
import { engineIds, loadEngineProfile } from "../engine/profile";
import { AssetResolver, bundledAssetsDirectory, userAssetsDirectory } from "../runtime/assets";
import { hostToolDefinitions } from "../tools";
import { resolveValidators } from "../validators/registry";
import { harnessAdapterCompatibilityIssue, unsupportedHarnessCapabilities } from "./capability";
import { loadHarnessManifest } from "./manifest";
import type { HarnessManifest, VerifiedHarnessPack } from "./types";

export type HarnessVerificationOptions = {
  env?: NodeJS.ProcessEnv;
  bundledDirectory?: string;
  executablePath?: string;
};

export async function verifyHarnessPack(
  directory: string,
  options: HarnessVerificationOptions = {},
): Promise<VerifiedHarnessPack> {
  const root = await resolvePackRoot(directory);
  const { manifest, source } = await loadHarnessManifest(root);
  const files = await listPackFiles(root);
  await verifyInventory(root, files, manifest);
  verifyManifestReferences(manifest);
  await verifyEmbeddedManifests(root, manifest);

  const hostAssetDirectories = defaultHostAssetDirectories(options);
  const missingExternalHostAssets = await missingHostAssets(manifest.externalHostAssets, hostAssetDirectories);
  if (missingExternalHostAssets.length === 0) {
    await verifyProfiles(root, manifest, options);
  }

  const unsupportedCapabilities = unsupportedHarnessCapabilities(manifest);
  const issues: string[] = [];
  if (manifest.sourceState !== "clean") issues.push("Harness sourceState is dirty.");
  const adapterIssue = harnessAdapterCompatibilityIssue(manifest);
  if (adapterIssue) issues.push(adapterIssue);
  if (unsupportedCapabilities.length > 0) {
    issues.push(`Unsupported Harness capabilities: ${unsupportedCapabilities.join(", ")}.`);
  }
  if (missingExternalHostAssets.length > 0) {
    issues.push(`Missing external host assets: ${missingExternalHostAssets.join(", ")}.`);
  }

  return {
    directory: root,
    manifestPath: join(root, "manifest.json"),
    manifestSha256: sha256(source),
    manifest,
    assetCount: Object.keys(manifest.assets).length,
    compatibility: {
      compatible: issues.length === 0,
      unsupportedCapabilities,
      missingExternalHostAssets,
      issues,
    },
  };
}

export function assertHarnessPackCompatible(pack: VerifiedHarnessPack): void {
  if (!pack.compatibility.compatible) {
    throw new Error(`Harness ${pack.manifest.id}@${pack.manifest.version} is not compatible:\n- ${pack.compatibility.issues.join("\n- ")}`);
  }
}

async function resolvePackRoot(directory: string): Promise<string> {
  const info = await lstat(directory).catch((error: unknown) => {
    throw new Error(`Cannot access Harness pack directory ${directory}: ${errorMessage(error)}`);
  });
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Harness pack root must be a real directory, not a file or symbolic link.");
  return realpath(directory);
}

async function listPackFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolutePath = join(directory, entry.name);
      const logicalPath = relative(root, absolutePath).split(sep).join("/");
      if (entry.isSymbolicLink()) throw new Error(`Harness pack contains a symbolic link: ${logicalPath}.`);
      if (entry.isDirectory()) await visit(absolutePath);
      else if (entry.isFile()) files.push(logicalPath);
      else throw new Error(`Harness pack contains an unsupported filesystem entry: ${logicalPath}.`);
    }
  }
  await visit(root);
  return files.sort();
}

async function verifyInventory(root: string, files: string[], manifest: HarnessManifest): Promise<void> {
  const expected = new Set(["manifest.json", ...Object.keys(manifest.assets)]);
  const actual = new Set(files);
  const missing = [...expected].filter((path) => !actual.has(path)).sort();
  const extra = [...actual].filter((path) => !expected.has(path)).sort();
  if (missing.length > 0) throw new Error(`Harness pack is missing manifest asset(s): ${missing.join(", ")}.`);
  if (extra.length > 0) throw new Error(`Harness pack contains unlisted file(s): ${extra.join(", ")}.`);

  for (const [path, expectedHash] of Object.entries(manifest.assets)) {
    const actualHash = sha256(await readFile(join(root, ...path.split("/"))));
    if (actualHash !== expectedHash) throw new Error(`Harness asset hash mismatch: ${path}.`);
  }
}

function verifyManifestReferences(manifest: HarnessManifest): void {
  const owned = new Set(Object.keys(manifest.assets));
  const external = new Set(manifest.externalHostAssets);
  assertOwned(manifest.driver.contract, owned, "Driver contract");
  assertOwned(manifest.driver.adapter, owned, "Host Adapter");
  if (manifest.assets[manifest.driver.contract] !== manifest.driver.contractHash) {
    throw new Error("Harness Driver contract hash does not match the asset inventory.");
  }
  if (manifest.assets[manifest.driver.adapter] !== manifest.driver.adapterHash) {
    throw new Error("Harness Host Adapter hash does not match the asset inventory.");
  }
  for (const module of manifest.ruleModules) assertOwned(module.manifest, owned, `Rule module ${module.id}`);
  for (const [id, path] of Object.entries(manifest.profileBindings)) assertOwned(path, owned, `Engine profile ${id}`);
  for (const [id, path] of Object.entries(manifest.agentProfileBindings)) assertOwned(path, owned, `Agent profile ${id}`);
  for (const path of external) {
    if (owned.has(path)) throw new Error(`External host asset is unexpectedly bundled in the Harness pack: ${path}.`);
  }
  for (const [owner, paths] of [
    ...Object.entries(manifest.promptBindings),
    ...Object.entries(manifest.agentPromptBindings),
  ]) {
    for (const path of paths) {
      if (!owned.has(path) && !external.has(path)) throw new Error(`Prompt binding ${owner} references undeclared asset ${path}.`);
    }
  }

  assertSameKeys("engine profile/prompt", manifest.profileBindings, manifest.promptBindings);
  assertSameKeys("engine profile/quality", manifest.profileBindings, manifest.qualityBindings);
  assertSameKeys("agent profile/prompt", manifest.agentProfileBindings, manifest.agentPromptBindings);
  assertSameKeys("agent profile/quality", manifest.agentProfileBindings, manifest.agentQualityBindings);
}

async function verifyEmbeddedManifests(root: string, manifest: HarnessManifest): Promise<void> {
  const requiredCapabilities = new Set(manifest.requiredCapabilities);
  const adapter = await readEmbeddedManifest(root, manifest.driver.adapter, "Harness Host Adapter");
  assertEmbeddedValue(adapter, "schema", "prism-host-adapter/v1", "Harness Host Adapter");
  assertEmbeddedValue(adapter, "id", manifest.driver.adapterId, "Harness Host Adapter");
  assertEmbeddedValue(adapter, "version", manifest.driver.adapterVersion, "Harness Host Adapter");
  assertEmbeddedValue(adapter, "targetHost", manifest.driver.targetHost, "Harness Host Adapter");
  assertDeclaredCapabilities(
    readEmbeddedStringList(adapter.capabilities, "Harness Host Adapter capabilities"),
    requiredCapabilities,
    "Harness Host Adapter",
  );
  const operationBindings = readEmbeddedObject(adapter.operationBindings, "Harness Host Adapter operationBindings");
  const runtimeCapabilities = new Set<string>();
  const bindingKinds = new Set(["tool-group", "interaction-tool", "runtime-capability", "optional-tool"]);
  for (const [operation, value] of Object.entries(operationBindings)) {
    const binding = readEmbeddedObject(value, `Harness Host Adapter operation binding ${operation}`);
    if (typeof binding.kind !== "string" || !bindingKinds.has(binding.kind)) {
      throw new Error(`Harness Host Adapter operation binding ${operation} has an invalid kind.`);
    }
    if (binding.kind === "runtime-capability") {
      if (typeof binding.capability !== "string" || binding.capability.length === 0) {
        throw new Error(`Harness Host Adapter operation binding ${operation} must declare a capability.`);
      }
      runtimeCapabilities.add(binding.capability);
    }
  }
  assertDeclaredCapabilities(
    [...runtimeCapabilities],
    requiredCapabilities,
    "Harness Host Adapter runtime",
  );

  const ruleModuleIds = new Set(manifest.ruleModules.map((module) => module.id));
  for (const [owner, bindings] of [
    ...Object.entries(manifest.qualityBindings),
    ...Object.entries(manifest.agentQualityBindings),
  ]) {
    for (const moduleId of Object.keys(bindings)) {
      if (!ruleModuleIds.has(moduleId)) {
        throw new Error(`Harness quality binding ${owner} references undeclared rule module ${moduleId}.`);
      }
    }
  }

  for (const module of manifest.ruleModules) {
    const ruleManifest = await readEmbeddedManifest(root, module.manifest, `Harness rule module ${module.id}`);
    assertEmbeddedValue(ruleManifest, "schema", "rule-pack/v1", `Harness rule module ${module.id}`);
    assertEmbeddedValue(ruleManifest, "module", module.id, `Harness rule module ${module.id}`);
    assertDeclaredCapabilities(
      readEmbeddedStringList(ruleManifest.requiredCapabilities, `Harness rule module ${module.id} requiredCapabilities`),
      requiredCapabilities,
      `Harness rule module ${module.id}`,
    );
  }
}

async function readEmbeddedManifest(root: string, path: string, label: string): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(join(root, ...path.split("/")), "utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${errorMessage(error)}`);
  }
  return readEmbeddedObject(value, label);
}

function readEmbeddedObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a JSON object.`);
  return value as Record<string, unknown>;
}

function assertEmbeddedValue(
  manifest: Record<string, unknown>,
  field: string,
  expected: string,
  label: string,
): void {
  if (manifest[field] !== expected) {
    throw new Error(`${label} field ${field} must match ${expected}.`);
  }
}

function readEmbeddedStringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new Error(`${label} must be a list of non-empty strings.`);
  }
  const capabilities = value as string[];
  if (new Set(capabilities).size !== capabilities.length) throw new Error(`${label} must contain unique values.`);
  return capabilities;
}

function assertDeclaredCapabilities(
  capabilities: string[],
  declared: Set<string>,
  label: string,
): void {
  const missing = capabilities.filter((capability) => !declared.has(capability)).sort();
  if (missing.length > 0) {
    throw new Error(`${label} capabilities are missing from requiredCapabilities: ${missing.join(", ")}.`);
  }
}

async function verifyProfiles(
  root: string,
  manifest: HarnessManifest,
  options: HarnessVerificationOptions,
): Promise<void> {
  assertExactKeys("Harness engine bindings", manifest.profileBindings, engineIds);
  const resolver = new AssetResolver(root, {
    env: options.env,
    bundledDirectory: options.bundledDirectory,
    executablePath: options.executablePath,
  });

  for (const engine of engineIds) {
    const expectedPath = `assets/engines/${engine}.profile.yaml`;
    if (manifest.profileBindings[engine] !== expectedPath) {
      throw new Error(`Harness engine binding ${engine} must use ${expectedPath}.`);
    }
    const profile = await loadEngineProfile(engine, root, resolver);
    if (!sameList(profile.systemPrompt, manifest.promptBindings[engine])) {
      throw new Error(`Harness prompt binding drift for engine ${engine}.`);
    }
    resolveBuiltInTools(profile, true, false);
    resolveValidators(profile.validators);
  }

  const hostToolNames = new Set(hostToolDefinitions.map((tool) => tool.function.name));
  for (const agentId of Object.keys(manifest.agentProfileBindings)) {
    const expectedPath = `assets/agents/${agentId}.agent.yaml`;
    if (manifest.agentProfileBindings[agentId] !== expectedPath) {
      throw new Error(`Harness Agent binding ${agentId} must use ${expectedPath}.`);
    }
    const profile = await loadAgentProfile(agentId, root, resolver);
    if (!sameList(profile.systemPrompt, manifest.agentPromptBindings[agentId])) {
      throw new Error(`Harness prompt binding drift for Agent ${agentId}.`);
    }
    assertChildToolDeclaration(profile.tools, hostToolNames);
  }
}

function defaultHostAssetDirectories(options: HarnessVerificationOptions): string[] {
  const directories = [userAssetsDirectory(options.env)];
  const bundled = options.bundledDirectory ?? bundledAssetsDirectory();
  if (bundled) directories.push(bundled);
  const executableAssets = join(dirname(options.executablePath ?? process.execPath), "assets");
  if (existsSync(join(executableAssets, "manifest.json"))) directories.push(executableAssets);
  return [...new Set(directories.map((directory) => resolve(directory)))];
}

async function missingHostAssets(paths: string[], directories: string[]): Promise<string[]> {
  const missing: string[] = [];
  for (const path of paths) {
    if (!await hostAssetExists(path, directories)) missing.push(path);
  }
  return missing;
}

async function hostAssetExists(logicalPath: string, directories: string[]): Promise<boolean> {
  const suffix = logicalPath.slice("assets/".length).split("/");
  for (const directory of directories) {
    const info = await lstat(directory).catch(() => undefined);
    if (!info?.isDirectory() || info.isSymbolicLink()) continue;
    const root = await realpath(directory);
    const candidate = join(root, ...suffix);
    const file = await lstat(candidate).catch(() => undefined);
    if (!file?.isFile() || file.isSymbolicLink()) continue;
    if (await realpath(candidate) === resolve(root, ...suffix)) return true;
  }
  return false;
}

function assertOwned(path: string, owned: Set<string>, label: string): void {
  if (!owned.has(path)) throw new Error(`${label} is missing from the Harness asset inventory: ${path}.`);
}

function assertSameKeys(label: string, left: Record<string, unknown>, right: Record<string, unknown>): void {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (!sameList(leftKeys, rightKeys)) throw new Error(`Harness ${label} binding keys do not match.`);
}

function assertExactKeys(label: string, value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (!sameList(actual, sortedExpected)) throw new Error(`${label} must contain exactly: ${sortedExpected.join(", ")}.`);
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
