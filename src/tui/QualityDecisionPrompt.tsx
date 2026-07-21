import type { QualityDecisionRequest } from "../core/quality";
import { truncateLine } from "./format";
import type { OptionItem } from "./types";
import { OptionPicker } from "./widgets/OptionPicker";

export function QualityDecisionPrompt(props: {
  decision: QualityDecisionRequest;
  selected: number;
  width: number;
  maxVisible?: number;
}) {
  return (
    <OptionPicker
      title={qualityDecisionTitle(props.decision, props.width - 4)}
      items={qualityDecisionItems(props.decision)}
      selected={props.selected}
      width={props.width}
      hint="current version is not confirmed clean"
      maxVisible={props.maxVisible ?? 3}
    />
  );
}

export function qualityDecisionItems(decision: QualityDecisionRequest): OptionItem[] {
  return [
    {
      id: "retry",
      label: decision.canRetry ? "Revise again" : "Revision unavailable",
      detail: decision.canRetry ? "one user-authorized Engine attempt" : decision.blockedReason ?? "verified identity mismatch",
    },
    { id: "accept", label: "Use current version", detail: "keep the quality warning and findings" },
    { id: "stop", label: "Stop", detail: "no provider call; keep the warning for later" },
  ];
}

export function qualityDecisionTitle(decision: QualityDecisionRequest, width: number): string {
  const target = decision.targets.find((entry) => entry.path)?.path ?? "assistant response";
  const state = decision.reason === "interrupted" ? "Revision interrupted" : "Revision exhausted";
  return truncateLine(`${state} · ${decision.findingCount} finding${decision.findingCount === 1 ? "" : "s"} · ${target}`, width);
}
