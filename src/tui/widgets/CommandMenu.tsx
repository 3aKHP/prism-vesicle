import { For } from "solid-js";
import { TextAttributes } from "@opentui/core";
import type { Command } from "../commands/types";
import { clampCommandMenuSelection } from "../commands/selection";
import { palette } from "../theme";
import { truncateLine } from "../format";

// The slash-command popup that floats above the composer. Pure presentation:
// it renders a sliding window of the already-filtered command list with the
// selected row highlighted. Filtering/selection live in app.tsx; this only
// draws rows. Visual language matches SessionPicker (">" marker + BOLD on the
// selected row) so the two pickers read as one family.

export type CommandMenuProps = {
  commands: Command[];
  selected: number;
  width: number;
  maxVisible?: number;
};

const MAX_VISIBLE = 8;
// Fixed column for "/name" so descriptions align across rows. The longest
// current command name is "reasoning" (10 with the slash); 14 keeps descriptions
// off the marker without wasting horizontal space in 80-col layouts.
const NAME_COLUMN = 14;

export function CommandMenu(props: CommandMenuProps) {
  const safeSelected = () => clampCommandMenuSelection(props.selected, props.commands.length);
  const win = () => visibleWindow(props.commands, safeSelected(), props.maxVisible ?? MAX_VISIBLE);

  return (
    <box flexDirection="column">
      <For each={win().visible}>
        {(cmd, getIndex) => {
          // Keep these as accessors. Command objects retain their identity as
          // selection changes, so Solid reuses each <For> row instead of
          // rerunning this callback; snapshots here would freeze old markers.
          const index = () => win().start + getIndex();
          const isSelected = () => index() === safeSelected();
          const name = truncateLine(padName(cmd.name), NAME_COLUMN);
          const descBudget = Math.max(0, props.width - NAME_COLUMN - 2);
          const desc = truncateLine(cmd.description, descBudget);
          const markerAttr = () => isSelected() ? TextAttributes.BOLD : TextAttributes.NONE;
          return (
            <box height={1} flexDirection="row">
              <text content={isSelected() ? ">" : " "} fg={palette.brand} attributes={markerAttr()} />
              <text content={name} fg={isSelected() ? palette.textPrimary : palette.textSecondary} attributes={markerAttr()} />
              <text content={desc} fg={isSelected() ? palette.textSecondary : palette.textDim} />
            </box>
          );
        }}
      </For>
    </box>
  );
}

function padName(name: string): string {
  return `/${name}`.padEnd(NAME_COLUMN);
}

/** Center the selected row in a sliding window, clamped to list bounds. */
function visibleWindow(commands: Command[], selected: number, maxRows: number): { start: number; visible: Command[] } {
  maxRows = Math.max(1, maxRows);
  const length = commands.length;
  if (length <= maxRows) return { start: 0, visible: commands };
  const half = Math.floor(maxRows / 2);
  const start = Math.max(0, Math.min(selected - half, length - maxRows));
  return { start, visible: commands.slice(start, start + maxRows) };
}
