import { For } from "solid-js";
import { wrapDisplayLines } from "../format";
import { palette } from "../theme";

export function artifactFocusPreviewLines(path: string, width: number): string[] {
  return wrapDisplayLines(path, Math.max(20, width - 4));
}

/** Full-width, transient path inspection for the focused sidebar artifact. */
export function ArtifactFocusPreview(props: { path: string; index: number; total: number; width: number }) {
  const lines = () => artifactFocusPreviewLines(props.path, props.width);
  return (
    <box border borderColor={palette.sectionBorder} paddingX={1} flexDirection="column" width="100%">
      <text content={`Artifact ${props.index + 1}/${props.total}`} fg={palette.brand} attributes={1} wrapMode="none" />
      <For each={lines()}>{(line) => <text content={line} fg={palette.textPrimary} wrapMode="none" />}</For>
    </box>
  );
}
