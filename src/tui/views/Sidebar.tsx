import { For } from "solid-js";
import { palette } from "../theme";
import { PanelLine } from "../widgets/PanelLine";
import { truncateLine, truncateMiddle } from "../format";
import { artifactRoots } from "../../core/artifacts/workbench";
import type { AgentCardState } from "../types";
import { visibleAgentCards } from "../agent-view";
import type { BackgroundProcessState } from "../../core/process/manager";

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
  qualityWarningPaths?: ReadonlySet<string>;
  selectedArtifactPath?: string;
  agents?: AgentCardState[];
  processes?: BackgroundProcessState[];
  currentSessionId?: string;
  width: number;
}) {
  const reasoningLabel = () => (props.reasoningMode === "collapsed" ? "preview" : props.reasoningMode);
  const mcpLines = () => mcpSidebarLines(props.mcp ?? { loading: false, configured: false, enabled: false, servers: [] }, props.width - 4);
  const processLine = () => processSidebarLines(props.processes ?? [], props.width - 4, props.currentSessionId)[0]!;
  return (
    <box title="Workspace" border borderColor={palette.sectionBorder} width={props.width} padding={1} flexDirection="column">
      <PanelLine content="Status" fg={palette.brandDim} attributes={1} />
      <PanelLine content={truncateLine(props.status, props.width - 4)} fg={statusColor(props.status)} attributes={1} />
      <PanelLine content=" " fg={palette.textDim} />
      <PanelLine content="Agents" fg={palette.brandDim} attributes={1} />
      <For each={agentSidebarLines(props.agents ?? [], props.width - 4, props.currentSessionId)}>
        {(line) => <PanelLine content={line.text} fg={line.color} attributes={line.active ? 1 : 0} />}
      </For>
      <PanelLine content="Shell" fg={palette.brandDim} attributes={1} />
      <PanelLine content={processLine().text} fg={processLine().color} attributes={processLine().active ? 1 : 0} />
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
                          content={artifactSidebarLine(artifact.path, root, index(), props.width - 4, props.qualityWarningPaths?.has(artifact.path) === true)}
                          fg={selected() ? palette.brand : props.qualityWarningPaths?.has(artifact.path) ? palette.warn : palette.textSecondary}
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

export function processSidebarLines(processes: BackgroundProcessState[], width: number, currentSessionId?: string): Array<{ text: string; color: string; active: boolean }> {
  const running = processes.filter((process) => process.status === "running");
  const process = running.at(-1);
  if (!process) return [{ text: "none active", color: palette.textDim, active: false }];
  const parked = currentSessionId && process.parentSessionId !== currentSessionId ? " · parked" : "";
  const more = running.length > 1 ? ` · +${running.length - 1} more` : "";
  return [{
    text: truncateMiddle(`● ${process.taskId} · running${parked}${more}`, width),
    color: palette.warn,
    active: true,
  }];
}

export function agentSidebarLines(cards: AgentCardState[], width: number, currentSessionId?: string): Array<{ text: string; color: string; active: boolean }> {
  const allVisible = cards.filter((card) => card.status === "queued"
    || card.status === "running"
    || card.status === "ready"
    || card.status === "integrating"
    || card.delivery === "pending"
    || card.delivery === "integrating");
  const visible = visibleAgentCards(cards);
  if (visible.length === 0) return [{ text: "none active", color: palette.textDim, active: false }];
  const lines: Array<{ text: string; color: string; active: boolean }> = visible.map((card) => {
    const symbol = card.status === "failed" ? "×" : card.status === "cancelled" ? "■" : card.status === "running" ? "●" : card.status === "queued" ? "○" : card.status === "integrating" ? "◈" : "◆";
    const color = card.status === "failed" ? palette.error : card.status === "running" ? palette.warn : card.status === "integrating" ? palette.gateAccent : palette.brand;
    const delivery = card.delivery === "pending" && card.status !== "ready" ? " · ready" : card.delivery === "integrating" && card.status !== "integrating" ? " · integrating" : "";
    const parked = currentSessionId && card.parentSessionId !== currentSessionId ? " · parked" : "";
    return {
      text: truncateLine(`${symbol} ${card.handle} · ${card.status}${delivery}${parked}`, width),
      color,
      active: true,
    };
  });
  if (allVisible.length > visible.length) {
    lines.push({
      text: truncateLine(`+${allVisible.length - visible.length} more · /agents`, width),
      color: palette.textMuted,
      active: false,
    });
  }
  return lines;
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

export function artifactSidebarLine(path: string, root: string, index: number, width: number, qualityWarning = false): string {
  const relativePath = path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
  const prefix = `${qualityWarning ? "! " : ""}${index}. `;
  return `${prefix}${truncateMiddle(relativePath, Math.max(8, width - prefix.length))}`;
}
