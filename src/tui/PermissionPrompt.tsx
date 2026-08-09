import { ThemedText } from "./theme-text";
import { For } from "solid-js";
import type { PermissionRequest } from "../core/permissions";
import type { GateFocusTarget } from "./GatePrompt";
import { palette } from "./theme";
import { PromptComposer } from "./PromptComposer";
import { processShellDisplay } from "../core/process/runtime";
import { displayWidth, truncateLine, visibleDisplayLines } from "./format";

export const permissionPanelHeight = 14;
const permissionContentRows = permissionPanelHeight - 2;
const hostAuthorityWarning = "This command may access project-external files and the network with your host-user authority. Its file changes are not guaranteed to rewind.";
const skillScriptAuthorityWarning = "This selected Skill script uses structured arguments but may access files and the network with your host-user authority. Its file changes are not guaranteed to rewind.";
type PermissionPromptKind = "host-command" | "skill-script" | "default";

export type PermissionPromptProps = {
  request: PermissionRequest;
  focused: GateFocusTarget;
  feedbackMode: GateFocusTarget | null;
  feedback: string;
  feedbackCursor: number;
  width: number;
};

export function PermissionPrompt(props: PermissionPromptProps) {
  const kind = (): PermissionPromptKind => props.request.permissionClass === "arbitrary_exec"
    ? "host-command"
    : props.request.permissionClass === "skill_exec"
      ? "skill-script"
      : "default";
  const detail = () => {
    if (props.request.executionPlan) return props.request.executionPlan.command;
    try {
      return JSON.stringify(JSON.parse(props.request.arguments || "{}"), null, 2);
    } catch {
      return props.request.arguments;
    }
  };
  const contentWidth = () => Math.max(20, props.width - 4);
  const flexibleLineBudget = () => Math.max(2, permissionContentRows
    - 5
    - (props.request.executionPlan?.executablePath ? 1 : 0)
    - (props.feedbackMode === "reject" ? 2 : 0));
  const warningLines = () => {
    const warning = kind() === "host-command"
      ? hostAuthorityWarning
      : kind() === "skill-script"
        ? skillScriptAuthorityWarning
        : undefined;
    return warning ? visibleDisplayLines(warning, contentWidth(), flexibleLineBudget() - 1) : [];
  };
  const detailLineBudget = () => Math.max(1, flexibleLineBudget() - warningLines().length);
  const detailLines = () => visibleDisplayLines(detail(), contentWidth(), detailLineBudget());
  const title = () => {
    const full = kind() === "host-command"
      ? "Permission required · HOST COMMAND"
      : kind() === "skill-script"
        ? "Permission required · SKILL SCRIPT"
        : "Permission required";
    if (displayWidth(full) <= contentWidth()) return full;
    return kind() === "host-command"
      ? "Permission · HOST COMMAND"
      : kind() === "skill-script"
        ? "Permission · SKILL SCRIPT"
        : "Permission";
  };
  const hint = () => {
    const full = "↑/↓ choose · Enter confirm · Tab feedback · Esc reject";
    return displayWidth(full) <= contentWidth() ? full : "↑/↓ · Enter · Tab · Esc reject";
  };
  return (
    <box
      border
      borderColor={kind() === "host-command" ? palette.error : palette.gateBorder}
      paddingX={1}
      flexDirection="column"
      width={props.width}
      height="100%"
    >
      <ThemedText
        content={title()}
        fg={kind() === "host-command" ? palette.error : palette.gateAccent}
        wrapMode="none"
      />
      <ThemedText content={truncateLine(`${props.request.toolName} · mode ${props.request.mode} · cwd .${props.request.executionPlan?.runInBackground ? " · background" : ""}${props.request.executionPlan ? ` · ${processShellDisplay(props.request.executionPlan)}` : ""}`, contentWidth())} fg={palette.textDim} wrapMode="none" />
      {props.request.executionPlan?.executablePath ? (
        <ThemedText content={truncateLine(`Interpreter: ${props.request.executionPlan.executablePath}`, contentWidth())} fg={palette.textDim} wrapMode="none" />
      ) : null}
      <For each={warningLines()}>{(line) => <ThemedText content={line} fg={kind() === "host-command" ? palette.error : palette.gateAccent} wrapMode="none" />}</For>
      <For each={detailLines()}>{(line) => <ThemedText content={line || " "} fg={palette.textPrimary} wrapMode="none" />}</For>
      <ThemedText content={`${props.focused === "confirm" ? "›" : " "} Allow once`} fg={props.focused === "confirm" ? palette.success : palette.textDim} wrapMode="none" />
      <ThemedText content={`${props.focused === "reject" ? "›" : " "} Reject`} fg={props.focused === "reject" ? palette.error : palette.textDim} wrapMode="none" />
      {props.feedbackMode === "reject" ? (
        <PromptComposer
          value={props.feedback}
          cursor={props.feedbackCursor}
          placeholder="Optional feedback for the model"
          width={contentWidth()}
          maxLines={2}
          focused={true}
        />
      ) : null}
      <ThemedText content={hint()} fg={palette.textDim} wrapMode="none" />
    </box>
  );
}
