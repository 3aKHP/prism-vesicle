import type { QualityDocumentMetricSignal, QualityMetricSignal } from "./types";

export const documentMetricSignals = [
  "micro_action_per_1000_chars",
  "action_list_verbs_per_paragraph",
  "cliche_per_1000_chars",
  "metaphor_markers_per_1000_chars",
  "reasoning_chain_per_1000_chars",
  "abstract_summary_per_1000_chars",
] as const satisfies readonly QualityDocumentMetricSignal[];

export const qualityMetricSignals = [
  "em_dash_per_100_chars",
  ...documentMetricSignals,
] as const satisfies readonly QualityMetricSignal[];

export function isDocumentMetricSignal(value: string): value is QualityDocumentMetricSignal {
  return (documentMetricSignals as readonly string[]).includes(value);
}

export function isQualityMetricSignal(value: string): value is QualityMetricSignal {
  return (qualityMetricSignals as readonly string[]).includes(value);
}
