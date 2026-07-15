import type { ProviderRegistry } from "../../config/providers";
import { renderModelDetails } from "./render";
import type { AgentArgumentDraft, FixedArgumentDraft, ModelArgumentDraft } from "./argument-completion";
import type { OptionItem } from "../types";

export function providerOptionItems(registry: ProviderRegistry): OptionItem[] {
  return registry.providers.map((provider) => ({
    id: provider.id,
    label: provider.id,
    detail: `${provider.protocol} · ${provider.models.length} model${provider.models.length === 1 ? "" : "s"}`,
  }));
}

export function modelOptionItems(registry: ProviderRegistry, providerId: string): OptionItem[] {
  const provider = registry.providers.find((entry) => entry.id === providerId);
  if (!provider) return [];
  return provider.models.map((model) => ({
    id: model.id,
    label: model.id,
    detail: renderModelDetails(model),
  }));
}

export function commandArgumentHint(
  modelDraft: ModelArgumentDraft | null,
  fixedDraft: FixedArgumentDraft | null,
  agentDraft: AgentArgumentDraft | null,
): string {
  const scope = modelDraft
    ? modelDraft.stage === "provider" ? "providers" : `models · ${modelDraft.providerId}`
    : fixedDraft?.command ?? (agentDraft ? agentDraft.stage === "stop" ? "running agents" : "agents" : "arguments");
  return `${scope} · ↑/↓ choose · Tab complete · Enter select`;
}
