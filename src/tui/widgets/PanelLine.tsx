/**
 * A single fixed-height line of styled text. The shared atomic for status
 * panels, sidebars, and any vertical key/value listing.
 */
export function PanelLine(props: { content: string; fg: string; attributes?: number }) {
  return (
    <box height={1}>
      <text content={props.content} fg={props.fg} attributes={props.attributes} width="100%" wrapMode="none" />
    </box>
  );
}
