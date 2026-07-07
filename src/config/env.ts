export type VesicleProvider = "openai-chat-compatible";

export type VesicleConfig = {
  provider: VesicleProvider;
  baseUrl: string;
  model: string;
  apiKey?: string;
};

export type ConfigStatus = VesicleConfig & {
  hasApiKey: boolean;
  missing: string[];
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): VesicleConfig {
  const provider = env.VESICLE_PROVIDER ?? "openai-chat-compatible";
  if (provider !== "openai-chat-compatible") {
    throw new Error(`Unsupported VESICLE_PROVIDER "${provider}" for M0.`);
  }

  return {
    provider,
    baseUrl: trimTrailingSlash(env.VESICLE_BASE_URL ?? "https://api.openai.com/v1"),
    model: env.VESICLE_MODEL ?? "gpt-4.1-mini",
    apiKey: env.VESICLE_API_KEY,
  };
}

export function inspectConfig(env: NodeJS.ProcessEnv = process.env): ConfigStatus {
  const config = loadConfig(env);
  const missing: string[] = [];

  if (!config.apiKey) missing.push("VESICLE_API_KEY");
  if (!config.baseUrl) missing.push("VESICLE_BASE_URL");
  if (!config.model) missing.push("VESICLE_MODEL");

  return {
    ...config,
    hasApiKey: Boolean(config.apiKey),
    missing,
  };
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
