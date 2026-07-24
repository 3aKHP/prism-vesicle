import { COMPACT_MARK } from "../brand-mark";
import { palette } from "../theme";
import { BrandMark } from "../widgets/BrandMark";

/**
 * Workspace page (Scope B / #62): the second top-level surface for direct
 * project-file work. B1 ships the placeholder — page identity, project-root
 * visibility, and the switch hint; the file tree (B2) and the editor (B3)
 * mount here. Static by design: the workspace baseline is calm, no motion
 * lives below the working surfaces.
 */
export function WorkspacePage(props: { projectRoot: string; width: number; height: number }) {
  return (
    <box
      flexDirection="column"
      width={props.width}
      height={props.height}
      border
      borderColor={palette.panelBorder}
    >
      <box flexGrow={1} flexDirection="column" alignItems="center" justifyContent="center">
        <BrandMark mark={COMPACT_MARK} />
        <box height={1} />
        <text content="WORKSPACE" fg={palette.brand} attributes={1} wrapMode="none" />
        <text content={props.projectRoot} fg={palette.textMuted} wrapMode="none" />
        <box height={1} />
        <text
          content="File tree arrives next (B2) — editor, validation, and external editor follow."
          fg={palette.textDim}
          wrapMode="none"
        />
        <text content="Ctrl+O switches between Chat and Workspace" fg={palette.textDim} wrapMode="none" />
      </box>
    </box>
  );
}
