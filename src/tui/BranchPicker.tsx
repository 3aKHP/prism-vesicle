import { ThemedText } from "./theme-text";
import { For, Show } from "solid-js";
import { TextAttributes } from "@opentui/core";
import { truncateLine } from "./format";
import { palette } from "./theme";
import {
  branchConfirmOptions,
  flattenBranchRows,
  type BranchPickerState,
  type BranchRow,
} from "./branch/controller";

const branchVisibleRowLimit = 9;
const branchIndentStep = 2;
const branchIndentMax = 8;

export function branchPickerPanelHeight(state: BranchPickerState): number {
  if (state.error) return 8;
  if (!state.confirm) {
    const rows = flattenBranchRows(state.forks, state.expanded);
    const visibleRows = Math.min(Math.max(rows.length, 1), branchVisibleRowLimit);
    return Math.max(8, visibleRows + 5);
  }
  const optionRows = branchConfirmOptions(state.confirm).length;
  const warningRows = (state.confirm.diffStats?.filesChanged.length ? 1 : 0)
    + 1 // truncation/leave-active-path warning
    + (state.confirm.candidate?.tainted ? 1 : 0)
    + (state.confirm.kind === "switch" && state.confirm.candidate?.bundleStatus !== "bundled" ? 1 : 0);
  return Math.min(14, 8 + optionRows + warningRows);
}

export function BranchPicker(props: { state: BranchPickerState; width: number }) {
  const rows = () => flattenBranchRows(props.state.forks, props.state.expanded);
  const visible = () => visibleBranchRows(rows(), props.state.selected, branchVisibleRowLimit);

  return (
    <box flexDirection="column" border borderColor={palette.panelBorder} paddingX={1} width="100%" height="100%">
      <box height={1} flexDirection="row">
        <ThemedText content="Candidate tree" fg={palette.brand} attributes={TextAttributes.BOLD} wrapMode="none" />
      </box>

      <Show when={props.state.error} fallback={
        <Show when={props.state.confirm} fallback={
          <Show when={rows().length > 0} fallback={<ThemedText content="No candidate branches yet — Ctrl+R regenerates the last turn." fg={palette.textSecondary} wrapMode="none" />}>
            <For each={visible()}>
              {(row) => {
                const selected = () => row.index === props.state.selected;
                return (
                  <box height={1} flexDirection="row">
                    <ThemedText content={selected() ? ">" : " "} fg={palette.brand} attributes={selected() ? TextAttributes.BOLD : TextAttributes.NONE} wrapMode="none" />
                    <ThemedText
                      content={branchRowLine(row.row, props.state, props.width - 5)}
                      fg={selected() ? palette.textPrimary : palette.textSecondary}
                      attributes={selected() ? TextAttributes.BOLD : TextAttributes.NONE}
                      wrapMode="none"
                    />
                  </box>
                );
              }}
            </For>
            <ThemedText content="↑/↓ move · ←/→ fold/unfold · Enter switch · r regenerate · Esc close" fg={palette.textDim} wrapMode="none" />
          </Show>
        }>
          {(confirm) => (
            <box flexDirection="column">
              <ThemedText
                content={truncateLine(confirm().kind === "regenerate"
                  ? `Regenerate this turn: ${cleanExcerpt(confirm().fork.promptExcerpt)}`
                  : `Switch to candidate: ${cleanExcerpt(confirm().candidate?.excerpt ?? "")}`, props.width - 4)}
                fg={palette.textSecondary}
                wrapMode="none"
              />
              <ThemedText
                content={truncateLine(confirm().kind === "regenerate"
                  ? "A new candidate re-runs the turn; later turns leave the active branch."
                  : "The active branch moves to this candidate; later turns on the current path are kept but hidden.", props.width - 4)}
                fg={palette.textDim}
                wrapMode="none"
              />
              <For each={branchConfirmOptions(confirm())}>
                {(option, index) => {
                  const selected = () => index() === confirm().selected;
                  return (
                    <box height={1} flexDirection="row">
                      <ThemedText content={selected() ? ">" : " "} fg={palette.brand} wrapMode="none" />
                      <ThemedText
                        content={option.label}
                        fg={selected() ? palette.textPrimary : palette.textSecondary}
                        attributes={selected() ? TextAttributes.BOLD : TextAttributes.NONE}
                        wrapMode="none"
                      />
                    </box>
                  );
                }}
              </For>
              <For each={confirm().diffStats?.filesChanged.length ? [confirm().diffStats!] : []}>
                {(stats) => <ThemedText content={truncateLine(`Files: ${stats.filesChanged.length} change${stats.filesChanged.length === 1 ? "" : "s"} +${stats.insertions} -${stats.deletions}${stats.filesChanged.length > 3 ? ` · ${stats.filesChanged.slice(0, 3).join(", ")} … +${stats.filesChanged.length - 3} more` : ""}`, props.width - 4)} fg={palette.textSecondary} wrapMode="none" />}
              </For>
              <For each={confirm().kind === "switch" && confirm().candidate?.bundleStatus !== "bundled" ? [true] : []}>
                {() => <ThemedText content={truncateLine("⚠ No saved file state for this candidate: files will not switch.", props.width - 4)} fg={palette.warn} wrapMode="none" />}
              </For>
              <For each={confirm().candidate?.tainted ? [true] : []}>
                {() => <ThemedText content={truncateLine("⚠ This branch ran a host process; some file changes may be incomplete.", props.width - 4)} fg={palette.error} wrapMode="none" />}
              </For>
              <ThemedText content={props.state.busy ? "Switching…" : "↑/↓ choose · Enter confirm · Esc back"} fg={palette.textDim} wrapMode="none" />
            </box>
          )}
        </Show>
      }>
        {(error) => (
          <box flexDirection="column">
            <ThemedText content={`Error: ${truncateLine(error(), props.width - 11)}`} fg={palette.error} wrapMode="none" />
            <ThemedText content="Esc to close" fg={palette.textDim} wrapMode="none" />
          </box>
        )}
      </Show>
    </box>
  );
}

function branchRowLine(row: BranchRow, state: BranchPickerState, width: number): string {
  const indent = " ".repeat(Math.min(row.depth * branchIndentStep, branchIndentMax));
  if (row.kind === "fork") {
    const arrow = state.expanded.includes(row.key) ? "▾" : "▸";
    const count = row.fork.candidates.length;
    return truncateLine(`${indent}${arrow} ${cleanExcerpt(row.fork.promptExcerpt) || "(no prompt)"} · ${count} candidate${count === 1 ? "" : "s"}`, width);
  }
  const candidate = row.candidate;
  const marker = candidate.activePath ? "●" : "○";
  const turns = candidate.authoredTurnCount > 0 ? ` · +${candidate.authoredTurnCount} turn${candidate.authoredTurnCount === 1 ? "" : "s"}` : "";
  const files = candidate.bundleStatus === "bundled" ? " · files" : candidate.bundleStatus === "degraded" ? " · files degraded" : " · no file state";
  return truncateLine(`${indent}${marker} ${cleanExcerpt(candidate.excerpt)}${turns}${files}`, width);
}

function cleanExcerpt(content: string): string {
  return content.replace(/\s+/g, " ").trim();
}

function visibleBranchRows(rows: BranchRow[], selected: number, maxRows: number): Array<{ row: BranchRow; index: number }> {
  const indexed = rows.map((row, index) => ({ row, index }));
  if (indexed.length <= maxRows) return indexed;
  const bounded = Math.max(0, Math.min(selected, indexed.length - 1));
  const start = Math.max(0, Math.min(bounded - Math.floor(maxRows / 2), indexed.length - maxRows));
  return indexed.slice(start, start + maxRows);
}
