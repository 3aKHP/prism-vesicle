import { test, expect } from "bun:test";
import { createSignal } from "solid-js";
import type { ModelCapabilities, ModelLimits } from "../../../src/config/env";
import type { PermissionMode } from "../../../src/core/permissions";
import type { ShellInterpreterPreference } from "../../../src/core/process/shell-profile";
import type { ProviderConfigStatus, ProviderRegistry } from "../../../src/config/providers";
import { createProviderConfigController } from "../../../src/tui/provider-config-controller";
import type { SidebarMcpState } from "../../../src/tui/views/Sidebar";

test("provider selection closes active session resources before changing owner signals", async () => {
  const registry: ProviderRegistry = {
    default: { provider: "next", model: "next-model" },
    providers: [{
      id: "next", protocol: "openai-responses", baseUrl: "https://api.example.test/v1",
      apiKeyEnv: "NEXT_KEY", responsesProfile: "openai-public", responsesTransport: "websocket",
      models: [{ id: "next-model" }],
    }],
    source: "file",
  };
  const inspected: ProviderConfigStatus = {
    provider: "openai-responses",
    providerId: "next",
    baseUrl: "https://api.example.test/v1",
    model: "next-model",
    apiKey: "secret",
    responsesProfile: "openai-public",
    responsesTransport: "websocket",
    hasApiKey: true,
    missing: [],
    registry,
    fileEnv: {},
    providerEnvPath: "/redacted/.env",
    hasProviderEnvFile: true,
  };
  const [providerRegistry, setProviderRegistry] = createSignal<ProviderRegistry | null>(null);
  const [activeProvider, setActiveProviderBase] = createSignal("old");
  const [activeModel, setActiveModelBase] = createSignal("old-model");
  const [, setActiveModelLimits] = createSignal<ModelLimits | undefined>();
  const [, setActiveModelCapabilities] = createSignal<ModelCapabilities | undefined>();
  const [, setProviderHasApiKey] = createSignal(false);
  const [, setProviderConfigReady] = createSignal(false);
  const [, setMcpStatus] = createSignal<SidebarMcpState>({ loading: false, configured: false, enabled: false, servers: [] });
  const [, setPermissionMode] = createSignal<PermissionMode>("MOMENTUM");
  const [, setShellExecEnabled] = createSignal(false);
  const [, setShellInterpreter] = createSignal<ShellInterpreterPreference>("auto");
  const [, setPermissionSettingsReady] = createSignal(false);
  const events: string[] = [];
  const controller = createProviderConfigController({
    dangerouslySkipPermissions: false,
    providerRegistry,
    setProviderRegistry,
    setActiveProvider: (value) => {
      events.push("provider");
      return setActiveProviderBase(value);
    },
    setActiveModel: (value) => {
      events.push("model");
      return setActiveModelBase(value);
    },
    setActiveModelLimits,
    setActiveModelCapabilities,
    setProviderHasApiKey,
    setProviderConfigReady,
    setMcpStatus,
    setPermissionMode,
    setShellExecEnabled,
    setShellInterpreter,
    setPermissionSettingsReady,
    thinkingTier: () => undefined,
    activeProvider,
    activeModel,
    setStatus: () => undefined,
    recordActivity: () => undefined,
    closeActiveProviderSession: () => events.push("close"),
    inspectProvider: async () => inspected,
  });

  await controller.applyProviderSelection({ provider: "next", model: "next-model" });

  expect(events.slice(0, 3)).toEqual(["close", "provider", "model"]);
  expect(activeProvider()).toBe("next");
  expect(activeModel()).toBe("next-model");
});
