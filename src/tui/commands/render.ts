// Pure render helpers for command output (engine list, model detail, artifact
// list). Format the system notices local commands push into the transcript.

import type { ProviderRegistry } from "../../config/providers";
import type { ArtifactEntry, ArtifactValidation } from "../../core/artifacts/workbench";
import { engineIds } from "../../core/engine/profile";
import type { EngineId } from "../../core/engine/profile";
import { engineDisplayName } from "../theme";

export function renderEngineList(activeEngine: EngineId): string {
  const labels: Record<EngineId, string> = {
    etl: "material to cards and persona prompts",
    runtime: "turn-by-turn interaction logs",
    evaluate: "artifact and continuity audits",
    weaver: "scene shard drafting",
    "weaver-orch": "long-form orchestration",
    dyad: "two-entity simulation data",
    stage: "continuous character-driven narrative",
  };
  const lines = ["Prism engines:"];
  for (const engine of engineIds) {
    const marker = engine === activeEngine ? "*" : " ";
    lines.push(`${marker} ${engineDisplayName(engine)} (${engine}) - ${labels[engine]}`);
  }
  lines.push("");
  lines.push("Use /engine <id> to switch a profile for future turns. Start Stage with /stage <character-card-path> <scenario-card-path>.");
  return lines.join("\n");
}

export function renderModelDetails(model: ProviderRegistry["providers"][number]["models"][number]): string {
  const details: string[] = [];
  if (model.generation?.temperature !== undefined) details.push(`temp ${model.generation.temperature}`);
  if (model.generation?.maxTokens !== undefined) details.push(`max ${model.generation.maxTokens}`);
  const capabilities = Object.entries(model.capabilities ?? {})
    .filter(([, enabled]) => enabled === true)
    .map(([name]) => name);
  if (capabilities.length > 0) details.push(`cap ${capabilities.join("/")}`);
  return details.join(", ");
}

export function renderArtifactList(entries: ArtifactEntry[]): string {
  if (entries.length === 0) return "No artifacts found yet.";
  const lines = ["Artifacts:"];
  entries.forEach((entry, index) => {
    lines.push(`${index + 1}. ${entry.path}`);
  });
  lines.push("");
  lines.push("Use /artifact <n|path> to preview or /validate <n|path> to validate.");
  return lines.join("\n");
}

export function renderValidationNotice(validation: ArtifactValidation | undefined): string {
  if (!validation) return "No validator matched this artifact.";
  const lines: string[] = [`Validation ${validation.ok ? "passed" : "found issues"}:`];
  for (const entry of validation.results) {
    const tag = entry.result.errors.length > 0 ? "✗" : entry.result.warnings.length > 0 ? "⚠" : "✓";
    lines.push(`  ${tag} ${entry.name}`);
    for (const error of entry.result.errors) lines.push(`      ${error}`);
    for (const warning of entry.result.warnings) lines.push(`      ${warning}`);
  }
  return lines.join("\n");
}
