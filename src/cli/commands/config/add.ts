// vesicle config add-provider — structured provider addition via JSON entry.
// Validates the entry, merges into the existing registry, serializes with the
// canonical serializer, writes atomically, and creates the empty .env slot for
// the provider's apiKeyEnv. Full re-parse validation after write.

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { loadProviderRegistry, providerConfigPathFromEnv, parseProviderConfig, parseEnvFile } from "../../../config/providers";
import type { ProviderProfile, ProviderModelProfile } from "../../../config/providers";
import { serializeProviderRegistry, setEnvValues } from "../../../setup/config-writer";
import { atomicWrite } from "../../../config/atomic-write";

type AddResult = {
  ok: true;
  operation: "add-provider";
  providerId: string;
  apiKeyEnv: string;
  path: string;
  envPath: string;
  summary: string;
  restartRequired: boolean;
};

export async function runAddProvider(args: string[]): Promise<void> {
  const jsonFlag = args.indexOf("--json");
  if (jsonFlag === -1 || jsonFlag + 1 >= args.length) {
    console.error("Usage: vesicle config add-provider --json '<entry>'");
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
    const result = await addProvider(entry);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

async function addProvider(entry: Record<string, unknown>): Promise<AddResult> {
  const profile = validateProviderEntry(entry);
  const registry = await loadProviderRegistry();

  if (registry.providers.some((provider) => provider.id === profile.id)) {
    throw new Error(`Provider "${profile.id}" already exists. Remove it manually or choose a different id.`);
  }

  registry.providers.push(profile);
  const providerPath = providerConfigPathFromEnv();
  const source = serializeProviderRegistry(registry);

  // Validate the serialized output by re-parsing. This catches any schema
  // violation that the entry validation missed.
  const envPath = join(dirname(providerPath), ".env");
  const existingEnv = await readEnvFile(envPath);
  const effectiveEnv = { ...process.env, ...parseEnvFile(existingEnv || "", envPath) };
  parseProviderConfig(source, providerPath, effectiveEnv);

  // Write .env first: if providers.yaml fails after, the extra empty slot is
  // harmless (no provider references it). The reverse order would leave a
  // provider without its apiKeyEnv slot — a broken state.
  // Only create the empty slot when the key is absent; never overwrite an
  // existing value (another provider may share this apiKeyEnv).
  const fileEnv = parseEnvFile(existingEnv || "", envPath);
  const keyAlreadyExists = fileEnv[profile.apiKeyEnv] !== undefined;
  if (!keyAlreadyExists) {
    const updatedEnv = setEnvValues(existingEnv, { [profile.apiKeyEnv]: "" });
    await atomicWrite(envPath, updatedEnv, 0o600);
  }
  await atomicWrite(providerPath, source);

  return {
    ok: true,
    operation: "add-provider",
    providerId: profile.id,
    apiKeyEnv: profile.apiKeyEnv,
    path: providerPath,
    envPath,
    summary: keyAlreadyExists
      ? `Provider "${profile.id}" added with ${profile.models.length} model(s). `
        + `${profile.apiKeyEnv} already has a value in .env — no changes made to it. Restart Vesicle to use the new provider.`
      : `Provider "${profile.id}" added with ${profile.models.length} model(s). `
        + `${profile.apiKeyEnv} created in .env with empty value — edit ${envPath} and paste your API key, then restart Vesicle.`,
    restartRequired: true,
  };
}

function validateProviderEntry(entry: Record<string, unknown>): ProviderProfile {
  const id = requireString(entry, "id");
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(id)) {
    throw new Error(`Provider id "${id}" must be lowercase alphanumeric with hyphens, starting and ending with a letter or digit.`);
  }
  const protocol = requireString(entry, "protocol");
  if (protocol !== "openai-chat-compatible" && protocol !== "openai-responses"
    && protocol !== "anthropic-messages" && protocol !== "gemini-generate-content") {
    throw new Error(`Invalid protocol "${protocol}". Must be one of: openai-chat-compatible, openai-responses, anthropic-messages, gemini-generate-content.`);
  }
  const baseUrl = requireString(entry, "baseUrl");
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`baseUrl must use http:// or https://.`);
    }
    if (parsed.username || parsed.password) {
      throw new Error(`baseUrl must not contain credentials. providers.yaml is a non-secret file.`);
    }
  } catch (error) {
    if (error instanceof Error && (error.message.includes("http") || error.message.includes("credentials"))) throw error;
    throw new Error(`Invalid baseUrl "${baseUrl}". Must be a complete URL.`);
  }
  const apiKeyEnv = requireString(entry, "apiKeyEnv");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) {
    throw new Error(`Invalid apiKeyEnv "${apiKeyEnv}". Must be a valid environment variable name.`);
  }

  const modelsRaw = entry.models;
  if (!Array.isArray(modelsRaw) || modelsRaw.length === 0) {
    throw new Error("Provider entry must include a non-empty models array.");
  }
  const models: ProviderModelProfile[] = modelsRaw.map((model: unknown, index: number) => {
    if (typeof model === "string") return { id: model };
    if (model && typeof model === "object" && "id" in model && typeof (model as Record<string, unknown>).id === "string") {
      return { id: (model as Record<string, unknown>).id as string };
    }
    throw new Error(`models[${index}] must be a string or an object with an "id" field.`);
  });

  const defaultModel = optionalString(entry, "defaultModel");
  if (defaultModel && !models.some((model) => model.id === defaultModel)) {
    throw new Error(`defaultModel "${defaultModel}" is not declared in models.`);
  }

  const responsesProfile = optionalString(entry, "responsesProfile");
  const responsesTransport = optionalString(entry, "responsesTransport");
  const authMethod = optionalString(entry, "authMethod");
  const userAgent = optionalString(entry, "userAgent");

  if (protocol === "openai-responses" && !responsesProfile) {
    throw new Error(`Provider "${id}" using openai-responses must declare responsesProfile.`);
  }
  if (protocol !== "openai-responses" && responsesProfile) {
    throw new Error(`Provider "${id}" cannot declare responsesProfile with protocol ${protocol}.`);
  }

  return {
    id,
    protocol: protocol as ProviderProfile["protocol"],
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiKeyEnv,
    ...(authMethod ? { authMethod: authMethod as ProviderProfile["authMethod"] } : {}),
    ...(userAgent ? { userAgent } : {}),
    ...(responsesProfile ? { responsesProfile: responsesProfile as ProviderProfile["responsesProfile"] } : {}),
    ...(responsesTransport ? { responsesTransport: responsesTransport as ProviderProfile["responsesTransport"] } : {}),
    ...(defaultModel ? { defaultModel } : {}),
    models,
  };
}

function requireString(entry: Record<string, unknown>, field: string): string {
  const value = entry[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Provider entry requires a non-empty "${field}" string.`);
  }
  return value.trim();
}

function optionalString(entry: Record<string, unknown>, field: string): string | undefined {
  const value = entry[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`Provider entry field "${field}" must be a string.`);
  return value.trim() || undefined;
}

async function readEnvFile(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isEnoent(error)) return "";
    throw error;
  }
}

function isEnoent(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code: string }).code === "ENOENT");
}
