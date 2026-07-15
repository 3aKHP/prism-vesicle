import { For } from "solid-js";
import type { GateFocusTarget } from "./GatePrompt";
import { wrapDisplayLines } from "./format";
import { palette } from "./theme";

const yoloDescriptions = {
  1: "YOLO automatically approves every model-visible tool, including shell_exec when enabled and all MCP tools.",
  2: "Shell commands may access project-external files and the network. MCP and SubAgents may cause external side effects. Rewind cannot guarantee recovery.",
} as const;

export function yoloPanelHeight(stage: 1 | 2, width: number): number {
  return wrapDisplayLines(yoloDescriptions[stage], Math.max(20, width - 4)).length + 6;
}

export function YoloPrompt(props: { stage: 1 | 2; focused: GateFocusTarget; width: number }) {
  const description = () => yoloDescriptions[props.stage];
  const descriptionLines = () => wrapDisplayLines(description(), Math.max(20, props.width - 4));
  return (
    <box border borderColor={palette.error} paddingX={1} flexDirection="column" width={props.width}>
      <text content={`DANGER · Enable YOLO (${props.stage}/2)`} fg={palette.error} attributes={1} wrapMode="none" />
      <For each={descriptionLines()}>{(line) => <text content={line} fg={palette.error} wrapMode="none" />}</For>
      <text content={`${props.focused === "confirm" ? "›" : " "} ${props.stage === 1 ? "Continue" : "Enable YOLO for this process"}`} fg={props.focused === "confirm" ? palette.error : palette.textDim} wrapMode="none" />
      <text content={`${props.focused === "reject" ? "›" : " "} Cancel`} fg={props.focused === "reject" ? palette.textPrimary : palette.textDim} wrapMode="none" />
      <text content="↑/↓ · Enter confirm · Esc cancel" fg={palette.textDim} wrapMode="none" />
    </box>
  );
}
