import { writeSetupConfiguration } from "./config-writer";
import { testMcpServer } from "./mcp-test";
import { discoverOpenAIModels } from "./model-discovery";
import type { SetupEffect, SetupEffectResult } from "./setup-state";

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
          result: await (dependencies.discoverModels ?? discoverOpenAIModels)(effect.baseUrl, effect.apiKey),
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
    const message = errorMessage(error);
    if (effect.kind === "discover-models") return { kind: "discovery-failed", error: message };
    if (effect.kind === "test-mcp") return { kind: "mcp-test-failed", error: message };
    return { kind: "save-failed", error: message };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message : String(error);
}
