import type { GateFocusTarget } from "./GatePrompt";
import { palette } from "./theme";

export function YoloPrompt(props: { stage: 1 | 2; focused: GateFocusTarget; width: number }) {
  return (
    <box border borderColor={palette.error} paddingX={1} flexDirection="column" width={props.width}>
      <text content={`DANGER · Enable YOLO (${props.stage}/2)`} fg={palette.error} attributes={1} />
      <text
        content={props.stage === 1
          ? "YOLO automatically approves every model-visible tool, including shell_exec when enabled and all MCP tools."
          : "Shell commands may access project-external files and the network. MCP and SubAgents may cause external side effects. Rewind cannot guarantee recovery."}
        fg={palette.error}
        wrapMode="word"
      />
      <text content={`${props.focused === "confirm" ? "›" : " "} ${props.stage === 1 ? "Continue" : "Enable YOLO for this process"}`} fg={props.focused === "confirm" ? palette.error : palette.textDim} />
      <text content={`${props.focused === "reject" ? "›" : " "} Cancel`} fg={props.focused === "reject" ? palette.textPrimary : palette.textDim} />
      <text content="↑/↓ choose · Enter confirm · Esc cancel" fg={palette.textDim} />
    </box>
  );
}
