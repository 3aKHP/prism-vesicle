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

export function qualityRewritePanelHeight(stage: 1 | 2, width: number): number {
  const inner = Math.max(20, width - 4);
  return wrapDisplayLines(stageDescriptions[stage], inner).length + 7;
}

function rewriteHint(width: number): string {
  const full = "↑/↓ choose · Enter confirm · Esc cancel";
  return full.length <= Math.max(20, width - 4)
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
  const description = () => stageDescriptions[props.stage];
  const descriptionLines = () => wrapDisplayLines(description(), Math.max(20, props.width - 4));
  const action = () => stageAction[props.stage];
  return (
    <box border borderColor={palette.error} paddingX={1} flexDirection="column" width={props.width} height="100%">
      <text content={`CONFIRM · Enable Review and Rewrite (${props.stage}/2)`} fg={palette.error} attributes={1} wrapMode="none" />
      <text content={`Judge: ${props.providerAlias}/${props.modelId} · ${props.judgeTimeoutMs} ms`} fg={palette.textPrimary} wrapMode="none" />
      <For each={descriptionLines()}>{(line) => <text content={line} fg={palette.error} wrapMode="none" />}</For>
      <text content={`${props.focused === "confirm" ? "›" : " "} ${action()}`} fg={props.focused === "confirm" ? palette.error : palette.textDim} wrapMode="none" />
      <text content={`${props.focused === "reject" ? "›" : " "} Cancel`} fg={props.focused === "reject" ? palette.textPrimary : palette.textDim} wrapMode="none" />
      <text content={rewriteHint(props.width)} fg={palette.textDim} wrapMode="none" />
    </box>
  );
}
