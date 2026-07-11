import { For } from "solid-js";
import { palette } from "../theme";
import { PanelLine } from "../widgets/PanelLine";
import { truncateLine, truncateMiddle } from "../format";
import { artifactRoots } from "../../core/artifacts/workbench";

/**
 * Semantic colour for the status line. `status` is a catch-all string (config
 * state, turn phase, command feedback), so colour by keyword.
 */
function statusColor(status: string): string {
  if (/error|missing/i.test(status)) return palette.error;
  if (/pending/i.test(status)) return palette.gateAccent;
  if (/sending|generating|calling|resolving|answering|in flight/i.test(status)) return palette.warn;
  if (/^complete/i.test(status)) return palette.success;
  return palette.textSecondary;
}

/**
 * Left sidebar: live status, thinking/reasoning display settings, session
 * pointer, and the persistent artifact list. Presentational — all state is
 * owned by the App shell and passed in as props.
 *
 * `artifacts` is typed structurally so this view only depends on the path
 * shape it renders.
 */
export function Sidebar(props: {
  status: string;
  thinkingTier?: string;
  reasoningMode: string;
  sessionPath: string;
  mcp?: SidebarMcpState;
  artifacts: { path: string }[];
  selectedArtifactPath?: string;
  width: number;
}) {
  const reasoningLabel = () => (props.reasoningMode === "collapsed" ? "preview" : props.reasoningMode);
  const mcpLines = () => mcpSidebarLines(props.mcp ?? { loading: false, configured: false, enabled: false, servers: [] }, props.width - 4);
  return (
    <box title="Workspace" border borderColor={palette.sectionBorder} width={props.width} padding={1} flexDirection="column">
      <PanelLine content="Status" fg={palette.brandDim} attributes={1} />
      <PanelLine content={truncateLine(props.status, props.width - 4)} fg={statusColor(props.status)} attributes={1} />
      <PanelLine content=" " fg={palette.textDim} />
      <PanelLine content="Effort" fg={palette.brandDim} attributes={1} />
      <PanelLine content={truncateLine(`tier: ${props.thinkingTier ?? "auto"}`, props.width - 4)} fg={palette.textPrimary} />
      <PanelLine content={truncateLine(`reasoning: ${reasoningLabel()}`, props.width - 4)} fg={palette.textPrimary} />
      <PanelLine content=" " fg={palette.textDim} />
      <PanelLine content="Session" fg={palette.brandDim} attributes={1} />
      <PanelLine content={truncateMiddle(props.sessionPath, props.width - 4)} fg={palette.textPrimary} />
      <PanelLine content=" " fg={palette.textDim} />
      <PanelLine content="MCP" fg={palette.brandDim} attributes={1} />
      <For each={mcpLines()}>
        {(line) => <PanelLine content={line.text} fg={line.ok ? palette.textPrimary : palette.error} />}
      </For>
      <PanelLine content=" " fg={palette.textDim} />
      <PanelLine content="Artifacts" fg={palette.brandDim} attributes={1} />
      <scrollbox width="100%" flexGrow={1}>
        <box flexDirection="column">
          <For each={artifactRoots}>
            {(root) => {
              const entries = () => artifactsInRoot(props.artifacts, root);
              return (
                <box flexDirection="column">
                  <PanelLine content={`${root}/`} fg={palette.textDim} />
                  <For each={entries()}>
                    {(artifact) => {
                      const index = () => props.artifacts.indexOf(artifact) + 1;
                      const selected = () => artifact.path === props.selectedArtifactPath;
                      return (
                        <PanelLine
                          content={artifactSidebarLine(artifact.path, root, index(), props.width - 4)}
                          fg={selected() ? palette.brand : palette.textSecondary}
                          attributes={selected() ? 1 : 0}
                        />
                      );
                    }}
                  </For>
                </box>
              );
            }}
          </For>
        </box>
      </scrollbox>
    </box>
  );
}

export type SidebarMcpState = {
  loading: boolean;
  configured: boolean;
  enabled: boolean;
  servers: SidebarMcpServer[];
};

export type SidebarMcpServer = {
  id: string;
  enabled: boolean;
  connected: boolean;
  toolCount: number;
  error?: string;
};

export function mcpSidebarLines(state: SidebarMcpState, width: number): Array<{ text: string; ok: boolean }> {
  if (state.loading) return [{ text: truncateLine("loading", width), ok: true }];
  if (!state.configured) return [{ text: truncateLine("not configured", width), ok: true }];
  if (!state.enabled) return [{ text: truncateLine("disabled", width), ok: true }];
  if (state.servers.length === 0) return [{ text: truncateLine("no servers", width), ok: false }];
  return state.servers.map((server) => {
    if (!server.enabled) return { text: truncateLine(`${server.id}: disabled`, width), ok: true };
    if (!server.connected) return { text: truncateLine(`${server.id}: error`, width), ok: false };
    return {
      text: truncateLine(`${server.id}: ${server.toolCount} tool${server.toolCount === 1 ? "" : "s"}`, width),
      ok: true,
    };
  });
}

function artifactsInRoot(artifacts: { path: string }[], root: string): { path: string }[] {
  return artifacts.filter((artifact) => artifact.path.startsWith(`${root}/`));
}

export function artifactSidebarLine(path: string, root: string, index: number, width: number): string {
  const relativePath = path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
  const prefix = `${index}. `;
  return `${prefix}${truncateMiddle(relativePath, Math.max(8, width - prefix.length))}`;
}
