import type { PermissionRequest } from "../core/permissions";
import type { GateFocusTarget } from "./GatePrompt";
import { palette } from "./theme";
import { PromptComposer } from "./PromptComposer";

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
  return (
    <box
      border
      borderColor={dangerous() ? palette.error : palette.gateBorder}
      paddingX={1}
      flexDirection="column"
      width={props.width}
    >
      <text
        content={dangerous() ? "Permission required · HOST COMMAND" : "Permission required"}
        fg={dangerous() ? palette.error : palette.gateAccent}
      />
      <text content={`${props.request.toolName} · mode ${props.request.mode} · cwd .`} fg={palette.textDim} />
      {dangerous() ? (
        <text content="This command may access project-external files and the network with your host-user authority. Its file changes are not guaranteed to rewind." fg={palette.error} />
      ) : null}
      <text content={detail()} fg={palette.textPrimary} wrapMode="word" />
      <text content={`${props.focused === "confirm" ? "›" : " "} Allow once`} fg={props.focused === "confirm" ? palette.success : palette.textDim} />
      <text content={`${props.focused === "reject" ? "›" : " "} Reject`} fg={props.focused === "reject" ? palette.error : palette.textDim} />
      {props.feedbackMode === "reject" ? (
        <PromptComposer
          value={props.feedback}
          cursor={props.feedbackCursor}
          placeholder="Optional feedback for the model"
          width={Math.max(20, props.width - 4)}
          maxLines={2}
        />
      ) : null}
      <text content="↑/↓ choose · Enter confirm · Tab feedback · Esc reject" fg={palette.textDim} />
    </box>
  );
}
