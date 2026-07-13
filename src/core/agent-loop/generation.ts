import type { VesicleConfig } from "../../config/env";
import type { VesicleRequest } from "../../providers/shared/types";

export function mergeGeneration(
  defaults: VesicleConfig["generation"],
  override: VesicleRequest["generation"],
): VesicleRequest["generation"] | undefined {
  const merged = {
    ...definedGeneration(defaults),
    ...definedGeneration(override),
  };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function definedGeneration(source: VesicleRequest["generation"] | undefined): VesicleRequest["generation"] {
  return {
    ...(source?.temperature !== undefined ? { temperature: source.temperature } : {}),
    ...(source?.maxTokens !== undefined ? { maxTokens: source.maxTokens } : {}),
    ...(source?.reasoningTier !== undefined ? { reasoningTier: source.reasoningTier } : {}),
  };
}

export function generationMetadata(generation: VesicleRequest["generation"] | undefined): Record<string, unknown> {
  return {
    ...(generation?.temperature !== undefined ? { temperature: generation.temperature } : {}),
    ...(generation?.maxTokens !== undefined ? { maxTokens: generation.maxTokens } : {}),
    ...(generation?.reasoningTier ? { reasoningTier: generation.reasoningTier } : {}),
  };
}
