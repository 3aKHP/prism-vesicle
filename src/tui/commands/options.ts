import type { ProviderRegistry } from "../../config/providers";
import { renderModelDetails } from "./render";
import type { CommandArgumentCompletion } from "./types";
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
  draft: CommandArgumentCompletion | null,
): string {
  return `${draft?.hint ?? "arguments"} · ↑/↓ choose · Tab complete · Enter select`;
}
