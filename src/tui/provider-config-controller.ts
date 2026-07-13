import { createSignal, type Accessor, type Setter } from "solid-js";
import type { ModelCapabilities, ModelLimits } from "../config/env";
import { loadPermissionSettings } from "../config/permissions";
import { inspectProviderConfig, type ProviderRegistry, type ProviderSelection } from "../config/providers";
import { inspectMcpConfig } from "../mcp/registry";
import type { ReasoningTier } from "../providers/shared/types";
import type { PermissionMode } from "../core/permissions";
import type { ActivityEntry } from "./types";
import type { SidebarMcpState } from "./views/Sidebar";

export type ProviderConfigControllerOptions = {
  dangerouslySkipPermissions: boolean;
  providerRegistry: Accessor<ProviderRegistry | null>;
  setProviderRegistry: Setter<ProviderRegistry | null>;
  setActiveProvider: Setter<string>;
  setActiveModel: Setter<string>;
  setActiveModelLimits: Setter<ModelLimits | undefined>;
  setActiveModelCapabilities: Setter<ModelCapabilities | undefined>;
  setProviderHasApiKey: Setter<boolean>;
  setProviderConfigReady: Setter<boolean>;
  setMcpStatus: Setter<SidebarMcpState>;
  setPermissionMode: Setter<PermissionMode>;
  setShellExecEnabled: Setter<boolean>;
  setPermissionSettingsReady: Setter<boolean>;
  thinkingTier: Accessor<ReasoningTier | undefined>;
  activeProvider: Accessor<string>;
  activeModel: Accessor<string>;
  setStatus: Setter<string>;
  recordActivity: (entry: ActivityEntry) => void;
};

export function createProviderState(dangerouslySkipPermissions: boolean) {
  const [providerRegistry, setProviderRegistry] = createSignal<ProviderRegistry | null>(null);
  const [activeProvider, setActiveProvider] = createSignal("loading");
  const [activeModel, setActiveModel] = createSignal("loading");
  const [activeModelLimits, setActiveModelLimits] = createSignal<ModelLimits | undefined>();
  const [activeModelCapabilities, setActiveModelCapabilities] = createSignal<ModelCapabilities | undefined>();
  const [providerHasApiKey, setProviderHasApiKey] = createSignal(false);
  const [providerConfigReady, setProviderConfigReady] = createSignal(false);
  const [mcpStatus, setMcpStatus] = createSignal<SidebarMcpState>({ loading: true, configured: false, enabled: false, servers: [] });
  const [permissionMode, setPermissionMode] = createSignal<PermissionMode>(dangerouslySkipPermissions ? "YOLO" : "MOMENTUM");
  const [shellExecEnabled, setShellExecEnabled] = createSignal(dangerouslySkipPermissions);
  const [permissionSettingsReady, setPermissionSettingsReady] = createSignal(dangerouslySkipPermissions);
  return {
    activeModel,
    activeModelCapabilities,
    activeModelLimits,
    activeProvider,
    mcpStatus,
    permissionMode,
    permissionSettingsReady,
    providerConfigReady,
    providerHasApiKey,
    providerRegistry,
    setActiveModel,
    setActiveModelCapabilities,
    setActiveModelLimits,
    setActiveProvider,
    setMcpStatus,
    setPermissionMode,
    setPermissionSettingsReady,
    setProviderConfigReady,
    setProviderHasApiKey,
    setProviderRegistry,
    setShellExecEnabled,
    shellExecEnabled,
  };
}

export function createProviderConfigController(options: ProviderConfigControllerOptions) {
  let providerConfigLoad: Promise<void> | null = null;
  let permissionSettingsLoad: Promise<void> | null = null;

  async function refreshProviderConfig(selection?: Partial<ProviderSelection>): Promise<void> {
    const inspected = await inspectProviderConfig(selection);
    applyInspectedProvider(inspected);
    options.recordActivity({ kind: "provider", text: `active ${inspected.providerId}/${inspected.model} (${inspected.registry.source})` });
  }

  async function applyProviderSelection(selection: Partial<ProviderSelection>): Promise<ProviderSelection> {
    const inspected = await inspectProviderConfig(selection);
    applyInspectedProvider(inspected);
    options.recordActivity({ kind: "provider", text: `switched to ${inspected.providerId}/${inspected.model}` });
    return { provider: inspected.providerId, model: inspected.model };
  }

  function applyInspectedProvider(inspected: Awaited<ReturnType<typeof inspectProviderConfig>>): void {
    options.setProviderRegistry(inspected.registry);
    options.setActiveProvider(inspected.providerId);
    options.setActiveModel(inspected.model);
    options.setActiveModelLimits(inspected.limits);
    options.setActiveModelCapabilities(inspected.capabilities);
    options.setProviderHasApiKey(inspected.hasApiKey);
    options.setProviderConfigReady(true);
    options.setStatus(inspected.hasApiKey ? "ready" : `missing API key for ${inspected.providerId}`);
  }

  async function refreshMcpStatus(): Promise<void> {
    options.setMcpStatus((current) => ({ ...current, loading: true }));
    const inspected = await inspectMcpConfig();
    options.setMcpStatus({
      loading: false,
      configured: inspected.configured,
      enabled: inspected.enabled,
      servers: inspected.statuses.map((status) => ({
        id: status.id,
        enabled: status.enabled,
        connected: status.connected,
        toolCount: status.toolCount,
        ...(status.error ? { error: status.error } : {}),
      })),
    });
  }

  async function ensureProviderRegistry(): Promise<ProviderRegistry> {
    const existing = options.providerRegistry();
    if (existing) return existing;
    await loadProviderConfigOnce();
    const loaded = options.providerRegistry();
    if (!loaded) throw new Error("Provider registry did not load.");
    return loaded;
  }

  function loadProviderConfigOnce(): Promise<void> {
    providerConfigLoad ??= refreshProviderConfig().finally(() => { providerConfigLoad = null; });
    return providerConfigLoad;
  }

  function loadPermissionSettingsOnce(): Promise<void> {
    permissionSettingsLoad ??= loadPermissionSettings().then((settings) => {
      options.setShellExecEnabled(options.dangerouslySkipPermissions || settings.shellExec);
      if (!options.dangerouslySkipPermissions) options.setPermissionMode(settings.defaultMode);
      options.setPermissionSettingsReady(true);
    }).finally(() => { permissionSettingsLoad = null; });
    return permissionSettingsLoad;
  }

  function activeProviderSelection(): ProviderSelection {
    return { provider: options.activeProvider(), model: options.activeModel() };
  }

  function activeGeneration(): { reasoningTier: ReasoningTier } | undefined {
    const reasoningTier = options.thinkingTier();
    return reasoningTier ? { reasoningTier } : undefined;
  }

  return {
    activeGeneration,
    activeProviderSelection,
    applyProviderSelection,
    ensureProviderRegistry,
    loadPermissionSettingsOnce,
    loadProviderConfigOnce,
    refreshMcpStatus,
    refreshProviderConfig,
  };
}
