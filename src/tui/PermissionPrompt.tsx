import { ThemedText } from "./theme-text";
import { For, Show } from "solid-js";
import type { PermissionRequest } from "../core/permissions";
import { type GateFocusTarget, type PromptZone, PromptBodyRow, promptBodyZoneHint } from "./GatePrompt";
import { palette } from "./theme";
import { PromptComposer } from "./PromptComposer";
import { processShellDisplay } from "../core/process/runtime";
import { bodyReadAffordance, bodyScrollIndicator, displayWidth, promptBodyWindow, truncateLine, visibleDisplayLines, wrapDisplayLines } from "./format";

export const permissionPanelHeight = 14;
/** Options-zone hint shared by rendering and tests (the gate and question
 * prompts export their zone hints from GatePrompt.tsx). */
export const permissionOptionsZoneHint = "↑/↓ choose · Enter confirm · Tab read · Esc reject";
export const hostAuthorityWarning = "This command may access project-external files and the network with your host-user authority. Its file changes are not guaranteed to rewind.";
export const skillScriptAuthorityWarning = "This selected Skill script uses structured arguments but may access files and the network with your host-user authority. Its file changes are not guaranteed to rewind.";
type PermissionPromptKind = "host-command" | "skill-script" | "default";

export type PermissionPromptProps = {
  request: PermissionRequest;
  focused: GateFocusTarget;
  feedbackMode: GateFocusTarget | null;
  feedback: string;
  feedbackCursor: number;
  width: number;
  height?: number;
  zone?: PromptZone;
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
  const flexibleLineBudget = () => Math.max(1, (props.height ?? permissionPanelHeight) - 2
    - 5
    - (props.request.executionPlan?.executablePath ? 1 : 0)
    - (props.focused === "reject" ? 2 : 0));
  const warningLines = () => {
    const warning = kind() === "host-command"
      ? hostAuthorityWarning
      : kind() === "skill-script"
        ? skillScriptAuthorityWarning
        : undefined;
    return warning && flexibleLineBudget() > 1 ? visibleDisplayLines(warning, contentWidth(), flexibleLineBudget() - 1) : [];
  };
  // Compact preview only; the shared reader owns the complete command/JSON.
  const detailLineBudget = () => Math.max(1, flexibleLineBudget() - warningLines().length);
  const detailWindow = () => promptBodyWindow(
    wrapDisplayLines(detail(), Math.max(20, contentWidth() - 1)),
    detailLineBudget(),
    0,
  );
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
    const full = permissionOptionsZoneHint;
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
        {(line) => <PromptBodyRow line={line} zone={props.zone} />}
      </For>
      <Show when={detailWindow().showIndicator} fallback={<box height={0} />}>
        <PromptBodyRow
          zone={props.zone}
          fg={props.zone === "body" ? palette.textPrimary : palette.gateAccent}
          line={props.zone === "body"
            ? bodyScrollIndicator(
                detailWindow().start,
                detailWindow().start + detailWindow().visible,
                detailWindow().lines.length,
                contentWidth(),
              )
            : bodyReadAffordance(detailWindow().lines.length - detailWindow().visible, contentWidth())}
        />
      </Show>
      <ThemedText content={`${props.focused === "confirm" ? "›" : " "} Allow once`} fg={props.focused === "confirm" ? palette.success : palette.textDim} wrapMode="none" />
      <ThemedText content={`${props.focused === "reject" ? "›" : " "} Reject`} fg={props.focused === "reject" ? palette.error : palette.textDim} wrapMode="none" />
      {/* The Reject note renders whenever Reject is focused (mirroring
          GatePrompt). It previously keyed on feedbackMode === "reject",
          which no code path ever set — the row was unreachable, so typed
          rejection reasons were sent unseen. */}
      {props.focused === "reject" ? (
        <PromptComposer
          value={props.feedback}
          cursor={props.feedbackCursor}
          placeholder="Optional feedback for the model"
          width={contentWidth()}
          maxLines={2}
          focused={props.zone !== "body"}
        />
      ) : null}
      <ThemedText content={hint()} fg={palette.textDim} wrapMode="none" />
    </box>
  );
}
