import { ThemedText } from "./theme-text";
import { createEffect, For, Show } from "solid-js";
import { TextAttributes } from "@3akhp/opentui-core";
import { useRenderer } from "@3akhp/opentui-solid";
import type { GateRequest, GateResolution } from "../core/gate/types";
import { bodyReadAffordance, bodyScrollIndicator, bodyScrollWindow, displayWidth } from "./format";
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
 * - Typing on the focused confirm option expands an inline note input
 *   (#268 item 4; the former explicit Tab-note toggle is gone).
 * - Reject owns a visible input but may be submitted empty.
 * - Tab toggles to a body-reading zone where ↑/↓ scroll the folded summary.
 */

/** Focus zone of an open decision prompt (#268 item 4): "options" is the
 * classic decision keymap; "body" reads the folded prompt text with the
 * arrows. Toggled by Tab / Shift+Tab on gate, permission, and question
 * prompts. */
export type PromptZone = "options" | "body";

/** Hint lines shared by the decision prompts' two zones; rendering and tests
 * share these exact strings so the affordances stay discoverable. */
export const gateOptionsZoneHint = "↑/↓ navigate · type to note · Enter select · Tab read · Esc cancel";
export const promptBodyZoneHint = "↑/↓ scroll · Home/End top/bottom · Tab back";

/** Column shown beside body text while the body zone owns the keyboard. The
 * wrap width reserves the column unconditionally so toggling zones never
 * reflows; while the options zone owns the keyboard the same column shows a
 * dim rail, so the body region stays visible as a focusable zone. */
export const BODY_ZONE_GUTTER = "▌";
export const BODY_ZONE_RAIL = "▏";

/** One rendered row of a decision-prompt body: the zone rail column plus the
 * wrapped text. Shared by the gate, permission, and question prompts
 * (#268 item 4). The text element must NOT claim width="100%" — in a row
 * box that would start it at column 0 and paint over the rail column
 * (visible only on blank lines, whose spaces paint nothing). */
export function PromptBodyRow(props: { line: string; zone?: PromptZone; fg?: string }) {
  const inBodyZone = () => props.zone === "body";
  return (
    <box height={1} flexDirection="row">
      <ThemedText
        content={inBodyZone() ? BODY_ZONE_GUTTER : BODY_ZONE_RAIL}
        fg={inBodyZone() ? palette.brand : palette.textDim}
        wrapMode="none"
      />
      <ThemedText content={props.line || " "} fg={props.fg ?? palette.textPrimary} wrapMode="none" />
    </box>
  );
}

export type GatePromptProps = {
  gate: GateRequest;
  focused: GateFocusTarget;
  feedbackMode: GateFocusTarget | null;
  feedback: string;
  feedbackCursor?: number;
  width?: number;
  maxSummaryLines?: number;
  showSummaryOption?: boolean;
  zone?: PromptZone;
  bodyScrollOffset?: number;
  onBodyExtent?: (total: number, visible: number) => void;
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
  // The gutter column is reserved in every zone so toggling zones never
  // reflows the wrapped summary (#268 item 4).
  const summaryWrapWidth = () => Math.max(MIN_SUMMARY_WIDTH - 1, (props.width ?? renderer.width) - 5);
  const summaryWindow = () => {
    const lines = wrapGateSummary(renderGateSummaryText(props.gate.summary), summaryWrapWidth());
    const budget = Math.max(1, props.maxSummaryLines ?? 4);
    // When folded, the position indicator takes the last summary row.
    const visible = Math.max(1, budget - (lines.length > budget ? 1 : 0));
    return { lines, visible, ...bodyScrollWindow(lines.length, visible, props.bodyScrollOffset ?? 0) };
  };
  createEffect(() => {
    const window = summaryWindow();
    props.onBodyExtent?.(window.lines.length, window.visible);
  });
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
      <box flexDirection="row" height={1}>
        <ThemedText content="◆ " fg={palette.gateAccent} wrapMode="none" />
        <ThemedText content={`Stop Gate: ${props.gate.gate}`} fg={palette.gateAccent} attributes={TextAttributes.BOLD} wrapMode="none" />
      </box>
      <box flexDirection="column">
        <For each={summaryWindow().lines.slice(summaryWindow().start, summaryWindow().end)}>
          {(line) => <PromptBodyRow line={line} zone={props.zone} />}
        </For>
        <Show when={summaryWindow().folded} fallback={<box height={0} />}>
          <PromptBodyRow
            zone={props.zone}
            fg={props.zone === "body" ? palette.textPrimary : palette.gateAccent}
            line={props.zone === "body"
              ? bodyScrollIndicator(
                  summaryWindow().start,
                  summaryWindow().start + summaryWindow().visible,
                  summaryWindow().lines.length,
                  Math.max(MIN_SUMMARY_WIDTH, (props.width ?? renderer.width) - 4),
                )
              : bodyReadAffordance(
                  summaryWindow().lines.length - summaryWindow().visible,
                  Math.max(MIN_SUMMARY_WIDTH, (props.width ?? renderer.width) - 4),
                )}
          />
        </Show>
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
        <ThemedText
          content={props.zone === "body" ? promptBodyZoneHint : gateOptionsZoneHint}
          fg={palette.textDim}
          wrapMode="none"
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
      <ThemedText
        content={gateOptionLine(props.index, props.label, props.focused)}
        fg={props.focused ? palette.textPrimary : palette.textSecondary}
        attributes={props.focused ? TextAttributes.BOLD : TextAttributes.NONE}
        width="100%"
        wrapMode="none"
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
  // Gate summaries preserve their character stream and wrap at the exact
  // display-column boundary. Generic display wrapping prefers word breaks,
  // so sharing that helper would silently collapse boundary whitespace here.
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

function FeedbackLine(props: { placeholder: string; value: string; cursor: number; width: number }) {
  return (
    <box marginLeft={4} height={1} flexDirection="row">
      <ThemedText content="✎ " fg={palette.warn} wrapMode="none" />
      <PromptComposer
        value={props.value}
        cursor={props.cursor}
        placeholder={props.placeholder}
        width={props.width}
        maxLines={1}
        focused={true}
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
