// vesicle config remove-model / remove-provider — delete models or whole providers.
// Refuses to leave the registry in a broken state: a provider's defaultModel
// cannot be removed without first switching it, and the global default provider
// cannot be removed without first switching the default.

import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { loadProviderRegistry, providerConfigPathFromEnv, parseProviderConfig } from "../../../config/providers";
import { serializeProviderRegistry } from "../../../setup/config-writer";
import { loadExperimentalQualitySettings } from "../../../config/quality";

type RemoveModelResult = {
  ok: true;
  operation: "remove-model";
  providerId: string;
  modelId: string;
  path: string;
  restartRequired: boolean;
};

type RemoveProviderResult = {
  ok: true;
  operation: "remove-provider";
  providerId: string;
  path: string;
  restartRequired: boolean;
};

export async function runRemoveModel(args: string[]): Promise<void> {
  if (args.length !== 2) {
    console.error("Usage: vesicle config remove-model <provider-id> <model-id>");
    process.exitCode = 1;
    return;
  }
  const [providerId, modelId] = args;
  try {
    const result = await removeModel(providerId!, modelId!);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export async function runRemoveProvider(args: string[]): Promise<void> {
  if (args.length !== 1) {
    console.error("Usage: vesicle config remove-provider <provider-id>");
    process.exitCode = 1;
    return;
  }
  const providerId = args[0]!;
  try {
    const result = await removeProvider(providerId);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

async function removeModel(providerId: string, modelId: string): Promise<RemoveModelResult> {
  const registry = await loadProviderRegistry();
  const provider = registry.providers.find((entry) => entry.id === providerId);
  if (!provider) {
    throw new Error(`Unknown provider "${providerId}". Available: ${registry.providers.map((entry) => entry.id).join(", ")}.`);
  }
  const modelIndex = provider.models.findIndex((model) => model.id === modelId);
  if (modelIndex === -1) {
    throw new Error(
      `Provider "${providerId}" does not declare model "${modelId}". `
      + `Available: ${provider.models.map((model) => model.id).join(", ")}.`,
    );
  }
  if (provider.defaultModel === modelId) {
    throw new Error(
      `Cannot remove model "${modelId}" because it is the default model for provider "${providerId}". `
      + `Switch the default first with: vesicle config set providers providers.${providerId}.defaultModel <another-model-id>`,
    );
  }
  if (registry.default.provider === providerId && registry.default.model === modelId) {
    throw new Error(
      `Cannot remove model "${modelId}" because it is the current default model. `
      + `Switch the default first with: vesicle config set providers default.model <another-model-id>`,
    );
  }

  provider.models.splice(modelIndex, 1);

  const path = providerConfigPathFromEnv();
  const source = serializeProviderRegistry(registry);
  parseProviderConfig(source, path, process.env);

  await atomicWrite(path, source);
  await loadProviderRegistry();

  return { ok: true, operation: "remove-model", providerId, modelId, path, restartRequired: true };
}

async function removeProvider(providerId: string): Promise<RemoveProviderResult> {
  const registry = await loadProviderRegistry();
  const providerIndex = registry.providers.findIndex((entry) => entry.id === providerId);
  if (providerIndex === -1) {
    throw new Error(`Unknown provider "${providerId}". Available: ${registry.providers.map((entry) => entry.id).join(", ")}.`);
  }
  if (registry.default.provider === providerId) {
    throw new Error(
      `Cannot remove provider "${providerId}" because it is the current default provider. `
      + `Switch the default first with: vesicle config set providers default.provider <another-provider-id>`,
    );
  }

  const quality = await loadExperimentalQualitySettings();
  if (quality.providerAlias === providerId) {
    throw new Error(
      `Cannot remove provider "${providerId}" because it is configured as the Semantic Judge in quality.yaml. `
      + `Switch the judge provider first or turn off the judge with: vesicle config set quality mode off`,
    );
  }

  registry.providers.splice(providerIndex, 1);

  const path = providerConfigPathFromEnv();
  const source = serializeProviderRegistry(registry);
  parseProviderConfig(source, path, process.env);

  await atomicWrite(path, source);
  await loadProviderRegistry();

  return { ok: true, operation: "remove-provider", providerId, path, restartRequired: true };
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
