// vesicle config add-model — append a model to an existing provider.
// Validates the JSON entry, ensures the model id is unique within the provider,
// serializes the registry, and writes atomically. Full re-parse validation after write.

import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { loadProviderRegistry, providerConfigPathFromEnv, parseProviderConfig } from "../../../config/providers";
import type { ProviderModelProfile } from "../../../config/providers";
import { serializeProviderRegistry } from "../../../setup/config-writer";

type AddModelResult = {
  ok: true;
  operation: "add-model";
  providerId: string;
  modelId: string;
  path: string;
  restartRequired: boolean;
};

export async function runAddModel(args: string[]): Promise<void> {
  if (args.length < 1) {
    console.error("Usage: vesicle config add-model <provider-id> --json '<entry>'");
    process.exitCode = 1;
    return;
  }
  const providerId = args[0]!;
  const jsonFlag = args.indexOf("--json");
  if (jsonFlag === -1 || jsonFlag + 1 >= args.length) {
    console.error("Usage: vesicle config add-model <provider-id> --json '<entry>'");
    process.exitCode = 1;
    return;
  }
  const jsonStr = args[jsonFlag + 1]!;
  let entry: Record<string, unknown>;
  try {
    entry = JSON.parse(jsonStr) as Record<string, unknown>;
  } catch {
    console.error("Invalid JSON. Provide a valid JSON object as the --json argument.");
    process.exitCode = 1;
    return;
  }

  try {
    const result = await addModel(providerId, entry);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

async function addModel(providerId: string, entry: Record<string, unknown>): Promise<AddModelResult> {
  const model = validateModelEntry(entry);
  const registry = await loadProviderRegistry();
  const provider = registry.providers.find((entry) => entry.id === providerId);
  if (!provider) {
    throw new Error(`Unknown provider "${providerId}". Available: ${registry.providers.map((entry) => entry.id).join(", ")}.`);
  }
  if (provider.models.some((existing) => existing.id === model.id)) {
    throw new Error(`Provider "${providerId}" already declares model "${model.id}".`);
  }

  provider.models.push(model);

  const path = providerConfigPathFromEnv();
  const source = serializeProviderRegistry(registry);

  // Validate the serialized output by re-parsing. This catches schema violations
  // that the entry validation missed (e.g. profile-specific model constraints).
  parseProviderConfig(source, path, process.env);

  await atomicWrite(path, source);
  // Verify round-trip.
  await loadProviderRegistry();

  return {
    ok: true,
    operation: "add-model",
    providerId,
    modelId: model.id,
    path,
    restartRequired: true,
  };
}

function validateModelEntry(entry: Record<string, unknown>): ProviderModelProfile {
  const id = requireString(entry, "id");
  if (!/^[^\s]+$/.test(id)) {
    throw new Error(`Model id "${id}" must not contain whitespace.`);
  }

  const model: ProviderModelProfile = { id };

  if (entry.generation !== undefined) {
    model.generation = validateGeneration(entry.generation);
  }
  if (entry.capabilities !== undefined) {
    model.capabilities = validateCapabilities(entry.capabilities);
  }
  if (entry.limits !== undefined) {
    model.limits = validateLimits(entry.limits);
  }

  return model;
}

function validateGeneration(value: unknown): NonNullable<ProviderModelProfile["generation"]> {
  if (!value || typeof value !== "object") {
    throw new Error("generation must be an object.");
  }
  const result: NonNullable<ProviderModelProfile["generation"]> = {};
  const source = value as Record<string, unknown>;
  if (source.temperature !== undefined) {
    result.temperature = readFiniteNumber(source.temperature, "temperature");
  }
  if (source.maxTokens !== undefined) {
    result.maxTokens = readPositiveInteger(source.maxTokens, "maxTokens");
  }
  return result;
}

function validateCapabilities(value: unknown): NonNullable<ProviderModelProfile["capabilities"]> {
  if (!value || typeof value !== "object") {
    throw new Error("capabilities must be an object.");
  }
  const validKeys = new Set(["streaming", "tools", "reasoningTier", "reasoningContent", "temperature", "maxTokens", "vision", "remoteCompact"]);
  const result: NonNullable<ProviderModelProfile["capabilities"]> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (!validKeys.has(key)) {
      throw new Error(`Unknown capability "${key}". Allowed: ${[...validKeys].join(", ")}.`);
    }
    if (typeof val !== "boolean") {
      throw new Error(`Capability "${key}" must be true or false.`);
    }
    (result as Record<string, boolean>)[key] = val;
  }
  return result;
}

function validateLimits(value: unknown): NonNullable<ProviderModelProfile["limits"]> {
  if (!value || typeof value !== "object") {
    throw new Error("limits must be an object.");
  }
  const source = value as Record<string, unknown>;
  const result: NonNullable<ProviderModelProfile["limits"]> = {};
  if (source.contextWindow !== undefined) {
    result.contextWindow = readPositiveInteger(source.contextWindow, "contextWindow");
  }
  if (source.maxOutputTokens !== undefined) {
    result.maxOutputTokens = readPositiveInteger(source.maxOutputTokens, "maxOutputTokens");
  }
  if (source.autoCompact !== undefined) {
    result.autoCompact = validateAutoCompact(source.autoCompact);
  }
  return result;
}

function validateAutoCompact(value: unknown): NonNullable<NonNullable<ProviderModelProfile["limits"]>["autoCompact"]> {
  if (!value || typeof value !== "object") {
    throw new Error("autoCompact must be an object.");
  }
  const source = value as Record<string, unknown>;
  const result: NonNullable<NonNullable<ProviderModelProfile["limits"]>["autoCompact"]> = {};
  if (source.enabled !== undefined) {
    if (typeof source.enabled !== "boolean") {
      throw new Error("autoCompact.enabled must be true or false.");
    }
    result.enabled = source.enabled;
  }
  if (source.threshold !== undefined) {
    result.threshold = readFraction(source.threshold, "autoCompact.threshold");
  }
  if (source.reserveOutputTokens !== undefined) {
    result.reserveOutputTokens = readPositiveInteger(source.reserveOutputTokens, "autoCompact.reserveOutputTokens");
  }
  return result;
}

function requireString(entry: Record<string, unknown>, field: string): string {
  const value = entry[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Model entry requires a non-empty "${field}" string.`);
  }
  return value.trim();
}

function readFiniteNumber(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${field} must be a finite number.`);
  }
  return parsed;
}

function readPositiveInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${field} must be a positive integer.`);
  }
  return parsed;
}

function readFraction(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 1) {
    throw new Error(`${field} must be a number greater than 0 and less than 1.`);
  }
  return parsed;
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const staging = `${path}.staging-${randomUUID()}`;
  try {
    await writeFile(staging, content, { encoding: "utf8", flag: "wx", mode: 0o644 });
    await rename(staging, path);
  } finally {
    await rm(staging, { force: true });
  }
}
