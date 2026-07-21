import { For, Show } from "solid-js";
import { TextAttributes } from "@opentui/core";
import type { RewindPoint } from "../core/rewind/service";
import type { RewindPickerState, RewindRestoreOption } from "./types";
import { truncateLine } from "./format";
import { palette } from "./theme";

export type RewindOption = {
  value: RewindRestoreOption;
  label: string;
};

const rewindVisibleRowLimit = 7;

export function rewindRestoreOptions(point: RewindPoint): RewindOption[] {
  const canRestoreCode = Boolean(point.diffStats?.filesChanged.length);
  return [
    ...(canRestoreCode
      ? [
          { value: "both" as const, label: "Restore code and conversation" },
          { value: "conversation" as const, label: "Restore conversation" },
          { value: "code" as const, label: "Restore code" },
        ]
      : [{ value: "conversation" as const, label: "Restore conversation" }]),
    { value: "summarize" as const, label: "Summarize from here" },
    { value: "nevermind" as const, label: "Never mind" },
  ];
}

export function rewindPickerPanelHeight(state: RewindPickerState): number {
  if (state.error) return 8;
  if (!state.target) {
    const visibleRows = Math.min(state.points.length + 1, rewindVisibleRowLimit);
    return Math.max(8, visibleRows + 5);
  }
  const optionRows = rewindRestoreOptions(state.target).length;
  const warningRows = (state.target.diffStats?.filesChanged.length ? 1 : 0) + (state.target.checkpointTainted ? 1 : 0);
  return Math.min(14, 8 + optionRows + warningRows);
}

export function RewindPicker(props: { state: RewindPickerState; width: number }) {
  const target = () => props.state.target;
  const options = () => target() ? rewindRestoreOptions(target()!) : [];
  const visible = () => visibleRewindRows(props.state.points, props.state.selected, rewindVisibleRowLimit);

  return (
    <box flexDirection="column" border borderColor={palette.panelBorder} paddingX={1} width="100%" height="100%">
      <box height={1} flexDirection="row">
        <text content="Rewind" fg={palette.brand} attributes={TextAttributes.BOLD} wrapMode="none" />
      </box>

      <Show when={props.state.error} fallback={
        <Show when={target()} fallback={
          <Show when={props.state.points.length > 0} fallback={<text content="Nothing to rewind to yet." fg={palette.textSecondary} wrapMode="none" />}>
            <text content="Restore the code and/or conversation to the point before…" fg={palette.textSecondary} wrapMode="none" />
            <For each={visible()}>
              {(row) => {
                const selected = () => row.index === props.state.selected;
                return (
                  <box height={1} flexDirection="row">
                    <text content={selected() ? ">" : " "} fg={palette.brand} attributes={selected() ? TextAttributes.BOLD : TextAttributes.NONE} wrapMode="none" />
                    <text
                      content={row.point ? rewindPointLine(row.point, props.width - 5) : "(current)"}
                      fg={selected() ? palette.textPrimary : palette.textSecondary}
                      attributes={selected() ? TextAttributes.BOLD : TextAttributes.NONE}
                      wrapMode="none"
                    />
                  </box>
                );
              }}
            </For>
            <text content="Enter to continue · Esc to exit" fg={palette.textDim} wrapMode="none" />
          </Show>
        }>
          {(point) => (
            <box flexDirection="column">
              <text content={truncateLine("Confirm you want to restore to the point before you sent this message:", props.width - 4)} fg={palette.textSecondary} wrapMode="none" />
              <text content={truncateLine(`  ${point().content.replace(/\s+/g, " ")} · ${formatRelativeTime(point().timestamp)}`, props.width - 4)} fg={palette.textPrimary} wrapMode="none" />
              <text content={truncateLine(restoreDescription(options()[props.state.restoreSelected]?.value, point()), props.width - 4)} fg={palette.textDim} wrapMode="none" />
              <For each={options()}>
                {(option, index) => {
                  const selected = () => index() === props.state.restoreSelected;
                  return (
                    <box height={1} flexDirection="row">
                      <text content={selected() ? ">" : " "} fg={palette.brand} wrapMode="none" />
                      <text
                        content={option.value === "summarize" && selected()
                          ? summaryInputLabel(option.label, props.state.summaryFeedback, props.state.summaryCursor, props.width - 6)
                          : option.label}
                        fg={selected() ? palette.textPrimary : palette.textSecondary}
                        attributes={selected() ? TextAttributes.BOLD : TextAttributes.NONE}
                        wrapMode="none"
                      />
                    </box>
                  );
                }}
              </For>
              <For each={point().diffStats?.filesChanged.length ? [true] : []}>
                {() => <text content={truncateLine("⚠ Rewinding does not affect files edited manually outside Vesicle tools.", props.width - 4)} fg={palette.warn} wrapMode="none" />}
              </For>
              <For each={point().checkpointTainted ? [true] : []}>
                {() => <text content={truncateLine("⚠ This turn ran shell_exec; its file changes may not be restored.", props.width - 4)} fg={palette.error} wrapMode="none" />}
              </For>
              <text content={props.state.busy
                ? props.state.restoringOption === "summarize" ? "Summarizing…" : "Restoring…"
                : "↑/↓ choose · Enter select · Esc back"} fg={palette.textDim} wrapMode="none" />
            </box>
          )}
        </Show>
      }>
        {(error) => (
          <box flexDirection="column">
            <text content={`Error: ${truncateLine(error(), props.width - 11)}`} fg={palette.error} wrapMode="none" />
            <text content="Esc to close" fg={palette.textDim} wrapMode="none" />
          </box>
        )}
      </Show>
    </box>
  );
}

function summaryInputLabel(label: string, value: string, cursor: number, width: number): string {
  const safeCursor = Math.max(0, Math.min(cursor, value.length));
  const withCursor = `${value.slice(0, safeCursor)}▏${value.slice(safeCursor)}`;
  return truncateLine(`${label}: ${withCursor}`, width);
}

function formatRelativeTime(timestamp: string): string {
  const elapsed = Math.max(0, Date.now() - new Date(timestamp).getTime());
  if (elapsed < 60_000) return "just now";
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function rewindPointLine(point: RewindPoint, width: number): string {
  const prompt = point.content.replace(/\s+/g, " ").trim() || "(no prompt)";
  const stats = point.turnDiffStats ?? point.diffStats;
  const suffix = stats
    ? stats.filesChanged.length > 0
      ? ` · ${stats.filesChanged.length} file${stats.filesChanged.length === 1 ? "" : "s"} +${stats.insertions} -${stats.deletions}`
      : " · No code changes"
    : " · No code restore";
  return truncateLine(`${prompt}${suffix}`, width);
}

function restoreDescription(option: RewindRestoreOption | undefined, point: RewindPoint): string {
  if (option === "summarize") return "Messages after this point will be summarized.";
  if (option === "code" || option === "nevermind") return "The conversation will be unchanged.";
  const files = point.diffStats?.filesChanged.length ?? 0;
  const code = option === "both" ? ` Code will restore ${files} file${files === 1 ? "" : "s"}.` : " Code will be unchanged.";
  return `The conversation will be forked.${code}`;
}

function visibleRewindRows(points: RewindPoint[], selected: number, maxRows: number): Array<{ point?: RewindPoint; index: number }> {
  const rows: Array<{ point?: RewindPoint; index: number }> = [
    ...points.map((point, index) => ({ point, index })),
    { index: points.length },
  ];
  if (rows.length <= maxRows) return rows;
  const bounded = Math.max(0, Math.min(selected, rows.length - 1));
  const start = Math.max(0, Math.min(bounded - Math.floor(maxRows / 2), rows.length - maxRows));
  return rows.slice(start, start + maxRows);
}
