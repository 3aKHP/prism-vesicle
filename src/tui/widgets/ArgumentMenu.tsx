import { For } from "solid-js";
import { TextAttributes } from "@opentui/core";
import type { OptionItem } from "../types";
import { clampCommandMenuSelection } from "../commands/selection";
import { palette } from "../theme";
import { padDisplayEnd, truncateLine } from "../format";

export type ArgumentMenuProps = {
  items: OptionItem[];
  selected: number;
  width: number;
  maxVisible?: number;
};

const LABEL_COLUMN = 22;

/** Keep a single-column candidate list readable when it has no per-item detail. */
export function argumentMenuLabelBudget(width: number, hasDetails: boolean): number {
  return hasDetails ? LABEL_COLUMN : Math.max(8, width - 1);
}

/** Inline command-argument candidates shown above the prompt composer. */
export function ArgumentMenu(props: ArgumentMenuProps) {
  const safeSelected = () => clampCommandMenuSelection(props.selected, props.items.length);
  const win = () => visibleWindow(props.items, safeSelected(), props.maxVisible ?? 8);
  const hasDetails = () => props.items.some((item) => Boolean(item.detail));

  return (
    <box flexDirection="column">
      <For each={win().visible}>
        {(item, getIndex) => {
          const index = () => win().start + getIndex();
          const isSelected = () => index() === safeSelected();
          const labelBudget = argumentMenuLabelBudget(props.width, hasDetails());
          const label = hasDetails()
            ? padDisplayEnd(truncateLine(item.label, labelBudget), labelBudget)
            : truncateLine(item.label, labelBudget);
          const detailBudget = Math.max(0, props.width - labelBudget - 2);
          const detail = item.detail ? truncateLine(item.detail, detailBudget) : "";
          const attributes = () => isSelected() ? TextAttributes.BOLD : TextAttributes.NONE;
          return (
            <box height={1} flexDirection="row">
              <text content={isSelected() ? ">" : " "} fg={palette.brand} attributes={attributes()} wrapMode="none" />
              <text content={label} fg={isSelected() ? palette.textPrimary : palette.textSecondary} attributes={attributes()} wrapMode="none" />
              <text content={detail} fg={isSelected() ? palette.textSecondary : palette.textDim} wrapMode="none" />
            </box>
          );
        }}
      </For>
    </box>
  );
}

function visibleWindow(items: OptionItem[], selected: number, maxRows: number): { start: number; visible: OptionItem[] } {
  const rows = Math.max(1, maxRows);
  if (items.length <= rows) return { start: 0, visible: items };
  const half = Math.floor(rows / 2);
  const start = Math.max(0, Math.min(selected - half, items.length - rows));
  return { start, visible: items.slice(start, start + rows) };
}
