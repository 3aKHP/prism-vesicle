import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { assertChildToolDeclaration } from "../agents/tool-scope";
import { loadAgentProfile } from "../agents/profile";
import { agentToolDefinitions } from "../agents/tools";
import { resolveBuiltInTools } from "../agent-loop/tool-surface";
import { engineSwitchToolDefinition } from "../engine/switch";
import { engineIds, loadEngineProfile } from "../engine/profile";
import { gateToolDefinition } from "../gate/types";
import {
  AssetResolver,
  bundledHostAssetsDirectory,
  type BundledHarnessLayout,
  userAssetsDirectory,
} from "../runtime/assets";
import { hostToolDefinitions } from "../tools";
import { askUserQuestionToolDefinition } from "../user-question/types";
import { resolveValidators } from "../validators/registry";
import { harnessAdapterCompatibilityIssue, unsupportedHarnessCapabilities } from "./capability";
import {
  parseHarnessDriverContract,
  parseHarnessHostAdapter,
  validateHarnessDelegationContract,
  type HarnessDriverContract,
  type HarnessHostAdapter,
} from "./driver";
import { loadHarnessManifest } from "./manifest";
import type { HarnessManifest, VerifiedHarnessPack } from "./types";

export type HarnessVerificationOptions = {
  env?: NodeJS.ProcessEnv;
  bundledDirectory?: string;
  hostAssetsDirectory?: string;
  executablePath?: string;
};

export async function verifyHarnessPack(
  directory: string,
  options: HarnessVerificationOptions = {},
): Promise<VerifiedHarnessPack> {
  return verifyHarnessPackLayout(directory, options, "manifest.json", "pack");
}

export async function verifyBundledHarnessPack(
  layout: BundledHarnessLayout,
  options: HarnessVerificationOptions = {},
): Promise<VerifiedHarnessPack> {
  return verifyHarnessPackLayout(
    layout.rootDirectory,
    { ...options, hostAssetsDirectory: layout.hostAssetsDirectory },
    "harness-manifest.json",
    "assets",
  );
}

async function verifyHarnessPackLayout(
  directory: string,
  options: HarnessVerificationOptions,
  manifestFileName: "manifest.json" | "harness-manifest.json",
  inventoryScope: "pack" | "assets",
): Promise<VerifiedHarnessPack> {
  const root = await resolvePackRoot(directory);
  const { manifest, source, path: manifestPath } = await loadHarnessManifest(root, manifestFileName);
  const files = inventoryScope === "pack" ? await listPackFiles(root) : await listAssetFiles(root);
  await verifyInventory(root, files, manifest, inventoryScope === "pack");
  verifyManifestReferences(manifest);
  const { driverContract, hostAdapter } = await verifyEmbeddedManifests(root, manifest);

  const hostAssetDirectories = defaultHostAssetDirectories(options);
  const missingExternalHostAssets = await missingHostAssets(manifest.externalHostAssets, hostAssetDirectories);
  if (missingExternalHostAssets.length === 0) {
    await verifyProfiles(root, manifest, driverContract, options);
  }

  const unsupportedCapabilities = unsupportedHarnessCapabilities(manifest);
  const issues: string[] = [];
  if (manifest.sourceState !== "clean") issues.push("Harness sourceState is dirty.");
  const adapterIssue = harnessAdapterCompatibilityIssue(manifest);
  if (adapterIssue) issues.push(adapterIssue);
  const unsupportedQualityBindings = unsupportedQualityPolicyBindings(manifest);
  if (unsupportedQualityBindings.length > 0) {
    issues.push(`Unsupported Harness quality bindings: ${unsupportedQualityBindings.join(", ")}.`);
  }
  if (unsupportedCapabilities.length > 0) {
    issues.push(`Unsupported Harness capabilities: ${unsupportedCapabilities.join(", ")}.`);
  }
  if (missingExternalHostAssets.length > 0) {
    issues.push(`Missing external host assets: ${missingExternalHostAssets.join(", ")}.`);
  }

  return {
    directory: root,
    manifestPath,
    manifestSha256: sha256(source),
    manifest,
    assetCount: Object.keys(manifest.assets).length,
    compatibility: {
      compatible: issues.length === 0,
      unsupportedCapabilities,
      missingExternalHostAssets,
      issues,
    },
    driverContract,
    hostAdapter,
  };
}

function unsupportedQualityPolicyBindings(manifest: HarnessManifest): string[] {
  const engineModes: Record<string, Set<string>> = {
    etl: new Set(["off"]),
    runtime: new Set(["off", "observe", "rewrite"]),
    evaluate: new Set(["off", "analyze"]),
    weaver: new Set(["off", "observe"]),
    "weaver-orch": new Set(["off", "observe"]),
    dyad: new Set(["off", "observe"]),
    stage: new Set(["off", "observe"]),
  };
  const agentModes: Record<string, Set<string>> = {
    "scene-writer": new Set(["off", "observe"]),
    "continuity-editor": new Set(["off"]),
    "chapter-reviewer": new Set(["off", "analyze"]),
  };
  return [
    ...unsupportedBindings(manifest.qualityBindings, engineModes),
    ...unsupportedBindings(manifest.agentQualityBindings, agentModes),
  ];
}

function unsupportedBindings(
  bindingsByOwner: HarnessManifest["qualityBindings"],
  supportedByOwner: Record<string, Set<string>>,
): string[] {
  return Object.entries(bindingsByOwner).flatMap(([owner, bindings]) => Object.entries(bindings)
    .filter(([module, mode]) => (module !== "anti-ai-flavor" && mode !== "off")
      || !(supportedByOwner[owner] ?? new Set(["off"])).has(mode))
    .map(([module, mode]) => `${owner}/${module}:${mode}`));
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

async function listAssetFiles(root: string): Promise<string[]> {
  const assets = join(root, "assets");
  const info = await lstat(assets).catch((error: unknown) => {
    throw new Error(`Cannot access bundled Harness assets: ${errorMessage(error)}`);
  });
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("Bundled Harness assets must be a real directory.");
  }
  return (await listPackFiles(assets)).map((path) => `assets/${path}`);
}

async function verifyInventory(
  root: string,
  files: string[],
  manifest: HarnessManifest,
  includeManifest: boolean,
): Promise<void> {
  const expected = new Set([...(includeManifest ? ["manifest.json"] : []), ...Object.keys(manifest.assets)]);
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

async function verifyEmbeddedManifests(
  root: string,
  manifest: HarnessManifest,
): Promise<{ driverContract: HarnessDriverContract; hostAdapter: HarnessHostAdapter }> {
  const requiredCapabilities = new Set(manifest.requiredCapabilities);
  const driverContract = parseHarnessDriverContract(
    await readEmbeddedManifest(root, manifest.driver.contract, "Harness Driver Contract"),
  );
  const adapter = await readEmbeddedManifest(root, manifest.driver.adapter, "Harness Host Adapter");
  const hostAdapter = parseHarnessHostAdapter(adapter);
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
  const knownToolNames = new Set([
    ...hostToolDefinitions,
    ...agentToolDefinitions,
    gateToolDefinition,
    askUserQuestionToolDefinition,
    engineSwitchToolDefinition,
  ].map((tool) => tool.function.name));
  for (const [operation, value] of Object.entries(operationBindings)) {
    const binding = readEmbeddedObject(value, `Harness Host Adapter operation binding ${operation}`);
    if (typeof binding.kind !== "string" || !bindingKinds.has(binding.kind)) {
      throw new Error(`Harness Host Adapter operation binding ${operation} has an invalid kind.`);
    }
    if (binding.kind === "tool-group") {
      const tools = readEmbeddedStringList(binding.tools, `Harness Host Adapter tool-group ${operation}`);
      if (tools.length === 0) throw new Error(`Harness Host Adapter tool-group ${operation} must not be empty.`);
      assertKnownAdapterTools(tools, knownToolNames, operation);
    } else if (binding.kind === "interaction-tool") {
      const tool = readEmbeddedString(binding.tool, `Harness Host Adapter interaction-tool ${operation}`);
      assertKnownAdapterTools([tool], knownToolNames, operation);
    } else if (binding.kind === "optional-tool") {
      readEmbeddedString(binding.tool, `Harness Host Adapter optional-tool ${operation}`);
    } else {
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
  validateHarnessDelegationContract(
    driverContract,
    hostAdapter,
    engineIds,
    Object.keys(manifest.agentProfileBindings),
  );
  const hasDelegations = Object.values(driverContract.engines).some((engine) => engine.delegations.length > 0);
  const declaresDelegationCapability = requiredCapabilities.has("prism-agent/delegation@1");
  if (hasDelegations !== declaresDelegationCapability) {
    throw new Error(hasDelegations
      ? "Harness Driver Contract delegations require prism-agent/delegation@1."
      : "Harness requires prism-agent/delegation@1 but the Driver Contract declares no delegations.");
  }
  return { driverContract, hostAdapter };
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

function readEmbeddedString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string.`);
  return value;
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

function assertKnownAdapterTools(tools: string[], known: Set<string>, operation: string): void {
  const unknown = tools.filter((tool) => !known.has(tool)).sort();
  if (unknown.length > 0) {
    throw new Error(`Harness Host Adapter operation ${operation} references unknown host tool(s): ${unknown.join(", ")}.`);
  }
}

async function verifyProfiles(
  root: string,
  manifest: HarnessManifest,
  driverContract: HarnessDriverContract,
  options: HarnessVerificationOptions,
): Promise<void> {
  assertExactKeys("Harness engine bindings", manifest.profileBindings, engineIds);
  const resolver = new AssetResolver(root, {
    env: options.env,
    includeOverrides: false,
    bundledDirectory: options.bundledDirectory,
    hostAssetsDirectory: options.hostAssetsDirectory,
    executablePath: options.executablePath,
    managedBaseline: {
      assetsDirectory: join(root, "assets"),
      externalHostAssets: manifest.externalHostAssets,
    },
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
    if (driverContract.agents[agentId]?.defaultMode !== profile.defaultMode) {
      throw new Error(`Harness Agent ${agentId} defaultMode does not match the Driver Contract.`);
    }
    // Explicit released-pack allowlists must be portable across projects, so
    // runtime-local MCP and parent-only tool names are not valid dependencies.
    assertChildToolDeclaration(profile.tools, hostToolNames);
  }
}

function defaultHostAssetDirectories(options: HarnessVerificationOptions): string[] {
  const directories = options.hostAssetsDirectory ? [] : [userAssetsDirectory(options.env)];
  const host = options.hostAssetsDirectory
    ?? options.bundledDirectory
    ?? bundledHostAssetsDirectory(options.executablePath);
  if (host) directories.push(host);
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
    const resolvedCandidate = await realpath(candidate).catch(() => undefined);
    if (resolvedCandidate !== resolve(root, ...suffix)) continue;
    const file = await lstat(resolvedCandidate).catch(() => undefined);
    if (file?.isFile() && !file.isSymbolicLink()) return true;
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
