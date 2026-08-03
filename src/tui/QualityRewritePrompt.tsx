import { ThemedText } from "./theme-text";
import { For } from "solid-js";
import { wrapDisplayLines } from "./format";
import { palette } from "./theme";

export type QualityRewriteFocus = "confirm" | "reject";

const stageDescriptions = {
  1: "Eligible narrative prose is sent to this Judge in an additional provider request, on top of the deterministic quality guard.",
  2: "Judge findings may request up to two original-Engine revisions of the same target. This is experimental and not calibrated production policy.",
} as const;

const stageAction = {
  1: "Continue",
  2: "Enable Review and Rewrite",
} as const;

function judgeLine(providerAlias: string, modelId: string, judgeTimeoutMs: number): string {
  return `Judge: ${providerAlias}/${modelId} · ${judgeTimeoutMs} ms`;
}

function innerWidth(width: number): number {
  return Math.max(20, width - 4);
}

export function qualityRewritePanelHeight(
  stage: 1 | 2,
  providerAlias: string,
  modelId: string,
  judgeTimeoutMs: number,
  width: number,
): number {
  const inner = innerWidth(width);
  const desc = wrapDisplayLines(stageDescriptions[stage], inner).length;
  const judge = wrapDisplayLines(judgeLine(providerAlias, modelId, judgeTimeoutMs), inner).length;
  // title + judge + description + action + cancel + hint + 2 border rows.
  return desc + judge + 6;
}

function rewriteHint(width: number): string {
  const full = "↑/↓ choose · Enter confirm · Esc cancel";
  return full.length <= innerWidth(width)
    ? full
    : "↑/↓ · Enter · Esc cancel";
}

export function QualityRewritePrompt(props: {
  stage: 1 | 2;
  focused: QualityRewriteFocus;
  providerAlias: string;
  modelId: string;
  judgeTimeoutMs: number;
  width: number;
}) {
  const inner = () => innerWidth(props.width);
  const judgeLines = () => wrapDisplayLines(judgeLine(props.providerAlias, props.modelId, props.judgeTimeoutMs), inner());
  const descriptionLines = () => wrapDisplayLines(stageDescriptions[props.stage], inner());
  const action = () => stageAction[props.stage];
  return (
    <box border borderColor={palette.error} paddingX={1} flexDirection="column" width={props.width} height="100%">
      <ThemedText content={`CONFIRM · Enable Review and Rewrite (${props.stage}/2)`} fg={palette.error} attributes={1} wrapMode="none" />
      <For each={judgeLines()}>{(line) => <ThemedText content={line} fg={palette.textPrimary} wrapMode="none" />}</For>
      <For each={descriptionLines()}>{(line) => <ThemedText content={line} fg={palette.error} wrapMode="none" />}</For>
      <ThemedText content={`${props.focused === "confirm" ? "›" : " "} ${action()}`} fg={props.focused === "confirm" ? palette.error : palette.textDim} wrapMode="none" />
      <ThemedText content={`${props.focused === "reject" ? "›" : " "} Cancel`} fg={props.focused === "reject" ? palette.textPrimary : palette.textDim} wrapMode="none" />
      <ThemedText content={rewriteHint(props.width)} fg={palette.textDim} wrapMode="none" />
    </box>
  );
}
