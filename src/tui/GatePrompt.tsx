import { For, Show } from "solid-js";
import { TextAttributes } from "@opentui/core";
import { useRenderer } from "@opentui/solid";
import type { GateRequest, GateResolution } from "../core/gate/types";
import { palette } from "./theme";

/**
 * Select-style gate prompt. Pure presentational component — all state
 * (focused option, feedback text) is owned by App and passed in as props,
 * which keeps the keyboard contract in one place (App's useKeyboard) and
 * makes the component trivially testable.
 *
 * Interaction shape borrows from Claude Code's PermissionPrompt:
 * - Numbered options with a focus indicator.
 * - Tab on confirm/revise expands an inline feedback input.
 * - A persistent "chat about this" escape hatch.
 */
export type GatePromptProps = {
  gate: GateRequest;
  focused: GateFocusTarget;
  feedbackMode: GateFocusTarget | null;
  feedback: string;
  onFeedbackInput: (value: string) => void;
  width?: number;
  maxSummaryLines?: number;
};

export type GateFocusTarget = "confirm" | "revise" | "chat";

export const gateFocusOrder: GateFocusTarget[] = ["confirm", "revise", "chat"];

const DEFAULT_CONFIRM_LABEL = "Confirm - proceed to next phase";
const DEFAULT_REVISE_LABEL = "Revise - tell the engine what to change";
const DEFAULT_CHAT_LABEL = "Chat about this";
const MIN_SUMMARY_WIDTH = 32;

export function GatePrompt(props: GatePromptProps) {
  const renderer = useRenderer();
  const confirmLabel = labelFor(props.gate, "confirm", DEFAULT_CONFIRM_LABEL);
  const reviseLabel = labelFor(props.gate, "revise", DEFAULT_REVISE_LABEL);
  const chatLabel = labelFor(props.gate, "chat", DEFAULT_CHAT_LABEL);
  const summaryLines = () => visibleGateSummaryLines(
    renderGateSummaryText(props.gate.summary),
    Math.max(MIN_SUMMARY_WIDTH, (props.width ?? renderer.width) - 4),
    props.maxSummaryLines ?? 4,
  );

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

      <OptionRow index={1} label={confirmLabel} focused={props.focused === "confirm"} />
      <Show when={props.feedbackMode === "confirm"} fallback={<box height={0} />}>
        <FeedbackLine
          placeholder="optional note: proceed, but also ..."
          value={props.feedback}
          onInput={props.onFeedbackInput}
        />
      </Show>

      <OptionRow index={2} label={reviseLabel} focused={props.focused === "revise"} />
      <Show when={props.feedbackMode === "revise"} fallback={<box height={0} />}>
        <FeedbackLine
          placeholder="tell the engine what to change"
          value={props.feedback}
          onInput={props.onFeedbackInput}
        />
      </Show>

      <OptionRow index={3} label={chatLabel} focused={props.focused === "chat"} />
      <Show when={props.focused === "chat"} fallback={<box height={0} />}>
        <FeedbackLine
          placeholder="chat freely before deciding"
          value={props.feedback}
          onInput={props.onFeedbackInput}
        />
      </Show>

      <box>
        <text
          content="↑/↓ navigate · Tab amend · Enter select · Esc cancel"
          fg={palette.textDim}
        />
      </box>
    </box>
  );
}

function labelFor(gate: GateRequest, decision: GateFocusTarget, fallback: string): string {
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

function FeedbackLine(props: { placeholder: string; value: string; onInput: (v: string) => void }) {
  return (
    <box marginLeft={4} flexDirection="row">
      <text content="✎ " fg={palette.warn} />
      <input
        focused
        placeholder={props.placeholder}
        value={props.value}
        onInput={props.onInput}
        width="100%"
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
  if (focused === "confirm") return text ? { decision: "confirm", feedback: text } : { decision: "confirm" };
  if (focused === "revise") return text ? { decision: "revise", feedback: text } : { decision: "revise" };
  return text ? { decision: "chat", feedback: text } : { decision: "chat" };
}
