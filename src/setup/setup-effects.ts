import { loadUserConfigEnvironment } from "../config/providers";
import { loadProviderProxyPolicy } from "../providers/shared/proxy";
import { writeSetupConfiguration } from "./config-writer";
import { testMcpServer } from "./mcp-test";
import { discoverOpenAIModels } from "./model-discovery";
import { setupErrorMessage, type SetupEffect, type SetupEffectResult } from "./setup-state";

async function resolveDiscoveryProxyUrl(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  // Only the explicit Vesicle proxy must be passed explicitly; inherited
  // terminal proxy env vars are honored by Bun's fetch directly.
  try {
    const userEnv = await loadUserConfigEnvironment(env);
    const policy = loadProviderProxyPolicy({ userFileEnv: userEnv.fileEnv, processEnv: env });
    return policy.kind === "explicit" ? policy.secretUrl.forBun() : undefined;
  } catch {
    // Invalid proxy configuration is reported through discovery's own error path.
    return undefined;
  }
}

export type SetupEffectDependencies = {
  env?: NodeJS.ProcessEnv;
  discoverModels?: typeof discoverOpenAIModels;
  testMcp?: typeof testMcpServer;
  writeConfiguration?: typeof writeSetupConfiguration;
};

export async function runSetupEffect(
  effect: SetupEffect,
  dependencies: SetupEffectDependencies = {},
): Promise<SetupEffectResult> {
  try {
    switch (effect.kind) {
      case "discover-models":
        return {
          kind: "discovery-succeeded",
          result: await (dependencies.discoverModels ?? discoverOpenAIModels)(
            effect.baseUrl,
            effect.apiKey,
            { proxyUrl: await resolveDiscoveryProxyUrl(dependencies.env ?? process.env) },
          ),
        };
      case "test-mcp":
        return {
          kind: "mcp-test-succeeded",
          result: await (dependencies.testMcp ?? testMcpServer)(effect.server),
        };
      case "save-configuration":
        return {
          kind: "save-succeeded",
          result: await (dependencies.writeConfiguration ?? writeSetupConfiguration)(effect.configuration, dependencies.env),
        };
    }
  } catch (error) {
    const message = setupErrorMessage(error);
    if (effect.kind === "discover-models") return { kind: "discovery-failed", error: message };
    if (effect.kind === "test-mcp") return { kind: "mcp-test-failed", error: message };
    return { kind: "save-failed", error: message };
  }
}
