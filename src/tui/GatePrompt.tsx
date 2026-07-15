import { For } from "solid-js";
import { TextAttributes } from "@opentui/core";
import { useRenderer } from "@opentui/solid";
import type { GateRequest, GateResolution } from "../core/gate/types";
import { palette } from "./theme";
import { PromptComposer } from "./PromptComposer";

/**
 * Select-style gate prompt. Pure presentational component — all state
 * (focused option, feedback text) is owned by App and passed in as props,
 * which keeps the keyboard contract in one place (App's useKeyboard) and
 * makes the component trivially testable.
 *
 * Interaction shape borrows from Claude Code's PermissionPrompt:
 * - Numbered options with a focus indicator.
 * - Tab on confirm expands an inline note input.
 * - Reject owns a visible input but may be submitted empty.
 */
export type GatePromptProps = {
  gate: GateRequest;
  focused: GateFocusTarget;
  feedbackMode: GateFocusTarget | null;
  feedback: string;
  feedbackCursor?: number;
  width?: number;
  maxSummaryLines?: number;
  showSummaryOption?: boolean;
};

export type GateFocusTarget = "confirm" | "confirm-summary" | "reject";

export const gateFocusOrder: GateFocusTarget[] = ["confirm", "reject"];
export const engineSwitchGateFocusOrder: GateFocusTarget[] = ["confirm", "confirm-summary", "reject"];

/** Reject always owns its visible composer; confirm requires Tab amend. */
export function gateComposerIsActive(
  focused: GateFocusTarget,
  feedbackMode: GateFocusTarget | null,
): boolean {
  return focused === "reject" || feedbackMode !== null;
}

export function gateSummaryLineBudget(maxLines: number, composerActive: boolean, extraOptionRows = 0): number {
  return Math.max(1, maxLines - (composerActive ? 1 : 0) - extraOptionRows);
}

const DEFAULT_CONFIRM_LABEL = "Confirm - proceed to next phase";
const DEFAULT_REJECT_LABEL = "Reject - discuss or request changes";
const MIN_SUMMARY_WIDTH = 32;

export function GatePrompt(props: GatePromptProps) {
  const renderer = useRenderer();
  const confirmLabel = labelFor(props.gate, "confirm", DEFAULT_CONFIRM_LABEL);
  const rejectLabel = labelFor(props.gate, "reject", DEFAULT_REJECT_LABEL);
  const summaryLines = () => visibleGateSummaryLines(
    renderGateSummaryText(props.gate.summary),
    Math.max(MIN_SUMMARY_WIDTH, (props.width ?? renderer.width) - 4),
    props.maxSummaryLines ?? 4,
  );
  const inputWidth = () => Math.max(MIN_SUMMARY_WIDTH, (props.width ?? renderer.width) - 8);
  const rows = (): GateRow[] => [
    { kind: "option", index: 1, label: confirmLabel, focused: props.focused === "confirm" },
    ...(props.feedbackMode === "confirm"
      ? [{ kind: "feedback" as const, placeholder: "optional note: proceed, but also ..." }]
      : []),
    ...(props.showSummaryOption
      ? [{ kind: "option" as const, index: 2, label: "Confirm with summary - compact context first", focused: props.focused === "confirm-summary" }]
      : []),
    { kind: "option", index: props.showSummaryOption ? 3 : 2, label: rejectLabel, focused: props.focused === "reject" },
    ...(props.focused === "reject"
      ? [{ kind: "feedback" as const, placeholder: "optional: what should change?" }]
      : []),
  ];

  return (
    <box flexDirection="column" border borderColor={palette.gateBorder} paddingX={1} width="100%" height="100%">
      <box flexDirection="row">
        <text content="◆ " fg={palette.gateAccent} />
        <text content={`Stop Gate: ${props.gate.gate}`} fg={palette.gateAccent} attributes={TextAttributes.BOLD} />
      </box>
      <box flexDirection="column">
        <For each={summaryLines()}>
          {(line) => (
            <box height={1}>
              <text content={line || " "} fg={palette.textPrimary} width="100%" />
            </box>
          )}
        </For>
      </box>

      <For each={rows()}>
        {(row) => row.kind === "option" ? (
          <OptionRow index={row.index} label={row.label} focused={row.focused} />
        ) : (
          <FeedbackLine
            placeholder={row.placeholder}
            value={props.feedback}
            cursor={props.feedbackCursor ?? props.feedback.length}
            width={inputWidth()}
          />
        )}
      </For>

      <box>
        <text
          content="↑/↓ navigate · Tab note · Enter select · Esc cancel"
          fg={palette.textDim}
        />
      </box>
    </box>
  );
}

function labelFor(gate: GateRequest, decision: GateFocusTarget, fallback: string): string {
  if (decision === "confirm-summary") return fallback;
  return sanitizeGateLabel(gate.options?.find((o) => o.decision === decision)?.label ?? fallback);
}

function OptionRow(props: { index: number; label: string; focused: boolean }) {
  return (
    <box height={1}>
      <text
        content={gateOptionLine(props.index, props.label, props.focused)}
        fg={props.focused ? palette.textPrimary : palette.textSecondary}
        attributes={props.focused ? TextAttributes.BOLD : TextAttributes.NONE}
        width="100%"
      />
    </box>
  );
}

type GateRow =
  | { kind: "option"; index: number; label: string; focused: boolean }
  | { kind: "feedback"; placeholder: string };

export function gateOptionLine(index: number, label: string, focused: boolean): string {
  const prefix = focused ? ">" : " ";
  return `${prefix}${index}. ${label}`;
}

export function sanitizeGateLabel(value: string): string {
  return value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function renderGateSummaryText(value: string): string {
  return value
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/__([^_\n]+)__/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1");
}

export function wrapGateSummary(value: string, maxWidth: number): string[] {
  const width = Math.max(1, maxWidth);
  const lines: string[] = [];

  for (const rawLine of value.replace(/\r\n?/g, "\n").split("\n")) {
    if (rawLine.length === 0) {
      lines.push("");
      continue;
    }

    let current = "";
    for (const char of rawLine) {
      const next = `${current}${char}`;
      if (current && displayWidth(next) > width) {
        lines.push(current);
        current = char.trimStart();
      } else {
        current = next;
      }
    }

    lines.push(current);
  }

  return lines.length > 0 ? lines : [""];
}

export function visibleGateSummaryLines(value: string, maxWidth: number, maxLines: number): string[] {
  const lines = wrapGateSummary(value, maxWidth);
  const limit = Math.max(1, maxLines);
  if (lines.length <= limit) return lines;
  return [...lines.slice(0, limit - 1), "..."];
}

function displayWidth(value: string): number {
  let width = 0;

  for (const char of value) {
    if (/[\u0300-\u036f]/u.test(char)) continue;
    width += isWideCharacter(char) ? 2 : 1;
  }

  return width;
}

function isWideCharacter(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff)
  );
}

function FeedbackLine(props: { placeholder: string; value: string; cursor: number; width: number }) {
  return (
    <box marginLeft={4} height={1} flexDirection="row">
      <text content="✎ " fg={palette.warn} />
      <PromptComposer
        value={props.value}
        cursor={props.cursor}
        placeholder={props.placeholder}
        width={props.width}
        maxLines={1}
      />
    </box>
  );
}

/**
 * Build the resolution object from the current gate UI state. Used by App
 * when Enter is pressed.
 */
export function gateResolutionFromState(
  focused: GateFocusTarget,
  feedback: string,
): GateResolution {
  const text = feedback.trim();
  if (focused === "confirm" || focused === "confirm-summary") return text ? { decision: "confirm", feedback: text } : { decision: "confirm" };
  return text ? { decision: "reject", feedback: text } : { decision: "reject" };
}
