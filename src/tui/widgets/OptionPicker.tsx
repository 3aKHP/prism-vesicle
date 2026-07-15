import { For } from "solid-js";
import { TextAttributes } from "@opentui/core";
import { palette } from "../theme";
import { truncateLine } from "../format";
import type { OptionItem } from "../types";

// A reusable bottom-panel list picker: a titled, bordered column of options
// with a ">" marker and BOLD on the selected row. /model uses it for its
// two-step provider→model selection; other host pickers can reuse it.
// Visual language matches SessionPicker so every picker reads as one family.
//
// The caller owns the items and selected index (and any multi-step state
// machine); this component is pure presentation. Row callbacks use accessors
// (not snapshots) so selection updates reactively even though <For> reuses
// rows by item identity — the same lesson CommandMenu learned.

export type OptionPickerProps = {
  title: string;
  items: OptionItem[];
  selected: number;
  width: number;
  hint?: string;
  maxVisible?: number;
};

const MAX_VISIBLE = 8;
// Fixed label column so details align across rows.
const LABEL_COLUMN = 22;

export function OptionPicker(props: OptionPickerProps) {
  const safeSelected = () => (props.items.length === 0 ? 0 : Math.max(0, Math.min(props.selected, props.items.length - 1)));
  const win = () => visibleWindow(props.items, safeSelected(), props.maxVisible ?? MAX_VISIBLE);

  return (
    <box flexDirection="column" border borderColor={palette.panelBorder} paddingX={1} width="100%" height="100%">
      <box flexDirection="row" height={1}>
        <text content={props.title} fg={palette.brand} attributes={TextAttributes.BOLD} />
        {props.hint ? <text content={`  ${props.hint}`} fg={palette.textDim} /> : null}
      </box>
      <For each={win().visible}>
        {(item, getIndex) => {
          // Accessors, not snapshots: items keep identity as selection moves,
          // so <For> reuses rows; only accessor reads stay reactive.
          const index = () => win().start + getIndex();
          const isSelected = () => index() === safeSelected();
          const label = truncateLine(item.label, LABEL_COLUMN);
          const padded = label.padEnd(LABEL_COLUMN);
          const detailBudget = Math.max(0, props.width - LABEL_COLUMN - 2);
          const detail = item.detail ? truncateLine(item.detail, detailBudget) : "";
          const attr = () => (isSelected() ? TextAttributes.BOLD : TextAttributes.NONE);
          return (
            <box height={1} flexDirection="row">
              <text content={isSelected() ? ">" : " "} fg={palette.brand} attributes={attr()} />
              <text content={padded} fg={isSelected() ? palette.textPrimary : palette.textSecondary} attributes={attr()} />
              <text content={detail} fg={isSelected() ? palette.textSecondary : palette.textDim} />
            </box>
          );
        }}
      </For>
    </box>
  );
}

/** Center the selected row in a sliding window, clamped to list bounds. */
function visibleWindow(items: OptionItem[], selected: number, maxRows: number): { start: number; visible: OptionItem[] } {
  maxRows = Math.max(1, maxRows);
  const length = items.length;
  if (length <= maxRows) return { start: 0, visible: items };
  const half = Math.floor(maxRows / 2);
  const start = Math.max(0, Math.min(selected - half, length - maxRows));
  return { start, visible: items.slice(start, start + maxRows) };
}
