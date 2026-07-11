import { For } from "solid-js";
import { TextAttributes } from "@opentui/core";
import type { SessionSummary } from "../core/session/store";
import { palette } from "./theme";

export type SessionPickerProps = {
  sessions: SessionSummary[];
  selected: number;
  width: number;
};

export function SessionPicker(props: SessionPickerProps) {
  const visible = () => visibleSessions(props.sessions, props.selected, 5);

  return (
    <box flexDirection="column" border borderColor={palette.panelBorder} paddingX={1} width="100%" height="100%">
      <box flexDirection="row" height={1}>
        <text content="Resume Session" fg={palette.brand} attributes={TextAttributes.BOLD} />
        <text content="  ↑/↓ choose · Enter resume · Esc close" fg={palette.textDim} />
      </box>
      <For each={visible()}>
        {(entry) => (
          <box height={1}>
            <text
              content={sessionPickerLine(entry.session, entry.index, entry.index === props.selected, props.width - 4)}
              fg={entry.index === props.selected ? palette.textPrimary : palette.textSecondary}
              attributes={entry.index === props.selected ? TextAttributes.BOLD : TextAttributes.NONE}
              width="100%"
            />
          </box>
        )}
      </For>
    </box>
  );
}

function visibleSessions(sessions: SessionSummary[], selected: number, maxRows: number): Array<{ session: SessionSummary; index: number }> {
  if (sessions.length <= maxRows) return sessions.map((session, index) => ({ session, index }));
  const half = Math.floor(maxRows / 2);
  const start = Math.max(0, Math.min(selected - half, sessions.length - maxRows));
  return sessions.slice(start, start + maxRows).map((session, offset) => ({ session, index: start + offset }));
}

export function sessionPickerLine(session: SessionSummary, index: number, selected: boolean, width: number): string {
  const marker = selected ? ">" : " ";
  const pending = session.pendingGate ? ` [gate:${session.pendingGate.gate}]` : "";
  const pendingEngine = session.pendingEngineSwitch ? ` [engine:${session.pendingEngineSwitch.targetEngine}]` : "";
  const pendingQuestion = session.pendingUserQuestion ? ` [question:${session.pendingUserQuestion.header}]` : "";
  const id = session.sessionId.slice(0, 24);
  const head = `${marker}${index + 1}. ${id}${pending}${pendingEngine}${pendingQuestion}`;
  const detail = `${session.preview} (${session.recordCount} records)`;
  return truncateLine(`${head}  ${detail}`, width);
}

function truncateLine(value: string, width: number): string {
  const limit = Math.max(8, width);
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 3)}...`;
}
