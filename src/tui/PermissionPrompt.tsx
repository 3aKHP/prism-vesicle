import { For } from "solid-js";
import type { PermissionRequest } from "../core/permissions";
import type { GateFocusTarget } from "./GatePrompt";
import { palette } from "./theme";
import { PromptComposer } from "./PromptComposer";
import { processShellDisplay } from "../core/process/runtime";
import { truncateLine, visibleDisplayLines, wrapDisplayLines } from "./format";

export const permissionPanelHeight = 14;
const permissionContentRows = permissionPanelHeight - 2;
const hostAuthorityWarning = "This command may access project-external files and the network with your host-user authority. Its file changes are not guaranteed to rewind.";

export type PermissionPromptProps = {
  request: PermissionRequest;
  focused: GateFocusTarget;
  feedbackMode: GateFocusTarget | null;
  feedback: string;
  feedbackCursor: number;
  width: number;
};

export function PermissionPrompt(props: PermissionPromptProps) {
  const dangerous = () => props.request.permissionClass === "arbitrary_exec";
  const detail = () => {
    if (props.request.executionPlan) return props.request.executionPlan.command;
    try {
      return JSON.stringify(JSON.parse(props.request.arguments || "{}"), null, 2);
    } catch {
      return props.request.arguments;
    }
  };
  const contentWidth = () => Math.max(20, props.width - 4);
  const warningLines = () => dangerous() ? wrapDisplayLines(hostAuthorityWarning, contentWidth()) : [];
  const detailLineBudget = () => Math.max(1, permissionContentRows
    - 5
    - (props.request.executionPlan?.executablePath ? 1 : 0)
    - warningLines().length
    - (props.feedbackMode === "reject" ? 2 : 0));
  const detailLines = () => visibleDisplayLines(detail(), contentWidth(), detailLineBudget());
  return (
    <box
      border
      borderColor={dangerous() ? palette.error : palette.gateBorder}
      paddingX={1}
      flexDirection="column"
      width={props.width}
      height="100%"
    >
      <text
        content={dangerous() ? "Permission required · HOST COMMAND" : "Permission required"}
        fg={dangerous() ? palette.error : palette.gateAccent}
        wrapMode="none"
      />
      <text content={truncateLine(`${props.request.toolName} · mode ${props.request.mode} · cwd .${props.request.executionPlan?.runInBackground ? " · background" : ""}${props.request.executionPlan ? ` · ${processShellDisplay(props.request.executionPlan)}` : ""}`, contentWidth())} fg={palette.textDim} wrapMode="none" />
      {props.request.executionPlan?.executablePath ? (
        <text content={truncateLine(`Interpreter: ${props.request.executionPlan.executablePath}`, contentWidth())} fg={palette.textDim} wrapMode="none" />
      ) : null}
      <For each={warningLines()}>{(line) => <text content={line} fg={palette.error} wrapMode="none" />}</For>
      <For each={detailLines()}>{(line) => <text content={line || " "} fg={palette.textPrimary} wrapMode="none" />}</For>
      <text content={`${props.focused === "confirm" ? "›" : " "} Allow once`} fg={props.focused === "confirm" ? palette.success : palette.textDim} wrapMode="none" />
      <text content={`${props.focused === "reject" ? "›" : " "} Reject`} fg={props.focused === "reject" ? palette.error : palette.textDim} wrapMode="none" />
      {props.feedbackMode === "reject" ? (
        <PromptComposer
          value={props.feedback}
          cursor={props.feedbackCursor}
          placeholder="Optional feedback for the model"
          width={contentWidth()}
          maxLines={2}
        />
      ) : null}
      <text content="↑/↓ choose · Enter confirm · Tab feedback · Esc reject" fg={palette.textDim} wrapMode="none" />
    </box>
  );
}
