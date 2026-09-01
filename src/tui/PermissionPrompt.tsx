import { ThemedText } from "./theme-text";
import { createEffect, For, Show } from "solid-js";
import type { PermissionRequest } from "../core/permissions";
import { BODY_ZONE_GUTTER, type GateFocusTarget, type PromptZone, promptBodyZoneHint } from "./GatePrompt";
import { palette } from "./theme";
import { PromptComposer } from "./PromptComposer";
import { processShellDisplay } from "../core/process/runtime";
import { bodyScrollIndicator, bodyScrollWindow, displayWidth, truncateLine, visibleDisplayLines, wrapDisplayLines } from "./format";

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
  zone?: PromptZone;
  bodyScrollOffset?: number;
  onBodyExtent?: (total: number, visible: number) => void;
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
  // Scrollable command/JSON detail (#268 item 4): wrapped once, windowed by
  // the shared body scroll offset; the gutter column is reserved in every
  // zone so toggling never reflows.
  const detailLineBudget = () => Math.max(1, flexibleLineBudget() - warningLines().length);
  const detailWindow = () => {
    const lines = wrapDisplayLines(detail(), Math.max(20, contentWidth() - 1));
    const budget = detailLineBudget();
    const visible = Math.max(1, budget - (lines.length > budget ? 1 : 0));
    return { lines, visible, ...bodyScrollWindow(lines.length, visible, props.bodyScrollOffset ?? 0) };
  };
  createEffect(() => {
    const window = detailWindow();
    props.onBodyExtent?.(window.lines.length, window.visible);
  });
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
    if (props.zone === "body") return promptBodyZoneHint;
    const full = "↑/↓ choose · Enter confirm · type note · Tab read · Esc reject";
    if (displayWidth(full) <= contentWidth()) return full;
    // Narrow fallback drops the self-evident ↑/↓ prefix so every remaining
    // key name stays whole.
    return "Enter · Tab read · Esc reject";
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
      <For each={detailWindow().lines.slice(detailWindow().start, detailWindow().end)}>
        {(line) => <ThemedText content={`${props.zone === "body" ? BODY_ZONE_GUTTER : " "}${line || " "}`} fg={palette.textPrimary} wrapMode="none" />}
      </For>
      <Show when={detailWindow().folded} fallback={<box height={0} />}>
        <ThemedText
          content={bodyScrollIndicator(
            detailWindow().start,
            detailWindow().start + detailWindow().visible,
            detailWindow().lines.length,
            contentWidth(),
          )}
          fg={palette.textDim}
          wrapMode="none"
        />
      </Show>
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
