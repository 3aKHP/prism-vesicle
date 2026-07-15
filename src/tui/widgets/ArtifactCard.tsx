import { renderArtifactMarkdownPreview } from "../markdown-display";
import { palette } from "../theme";

/** A bounded, structure-preserving artifact preview embedded in the transcript. */
export function ArtifactCard(props: {
  path: string;
  content: string;
  truncated: boolean;
}) {
  return (
    <box flexDirection="column">
      <box flexDirection="row">
        <box width={1} backgroundColor={palette.laneSystem} />
        <box flexDirection="column" border borderColor={palette.sectionBorder} paddingX={1} flexGrow={1}>
          <text content={`▤ ${props.path}`} fg={palette.brand} attributes={1} />
          <text content={renderArtifactMarkdownPreview(props.content)} fg={palette.textPrimary} />
          {props.truncated ? <text content="Preview truncated to 80 lines / 6000 characters." fg={palette.textDim} /> : null}
        </box>
      </box>
      <text content=" " fg={palette.textDim} />
    </box>
  );
}

export { renderArtifactMarkdownPreview } from "../markdown-display";
