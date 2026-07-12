import type { AgentCardState } from "../types";
import { palette } from "../theme";
import { truncateLine } from "../format";

export function AgentCard(props: { agent: AgentCardState; width: number }) {
  const state = () => agentCardPresentation(props.agent);
  const bodyWidth = () => Math.max(20, props.width - 6);
  return (
    <box flexDirection="column">
      <box flexDirection="row">
        <box width={1} backgroundColor={palette.brandDim} />
        <box flexDirection="column" paddingX={1} flexGrow={1}>
          <text
            content={truncateLine(`${state().symbol} ${props.agent.handle} · ${props.agent.profileId} · ${props.agent.mode}`, bodyWidth())}
            fg={state().color}
            attributes={1}
          />
          <text content={truncateLine(props.agent.description, bodyWidth())} fg={palette.textPrimary} />
          <text content={truncateLine(state().detail, bodyWidth())} fg={palette.textSecondary} />
          {props.agent.resultPreview && isTerminalForPreview(props.agent.status) && (
            <text content={truncateLine(`result · ${props.agent.resultPreview}`, bodyWidth())} fg={palette.textMuted} />
          )}
        </box>
      </box>
      <text content=" " fg={palette.textDim} />
    </box>
  );
}

export function agentCardPresentation(agent: AgentCardState): { symbol: string; color: string; detail: string } {
  const elapsed = elapsedLabel(agent.createdAt, agent.updatedAt);
  const usage = usageLabel(agent);
  const tools = agent.toolUses ? `${agent.toolUses} tool use${agent.toolUses === 1 ? "" : "s"}` : undefined;
  const suffix = [tools, usage, elapsed].filter(Boolean).join(" · ");
  const detail = [agent.progress ?? defaultProgress(agent.status), suffix].filter(Boolean).join(" · ");
  switch (agent.status) {
    case "queued": return { symbol: "○", color: palette.textMuted, detail };
    case "running": return { symbol: "●", color: palette.warn, detail };
    case "ready": return { symbol: "◆", color: palette.brand, detail };
    case "integrating": return { symbol: "◈", color: palette.gateAccent, detail };
    case "integrated": return { symbol: "✓", color: palette.success, detail };
    case "completed": return { symbol: "✓", color: palette.success, detail };
    case "failed": return { symbol: "×", color: palette.error, detail };
    case "cancelled": return { symbol: "■", color: palette.textMuted, detail };
  }
}

function defaultProgress(status: AgentCardState["status"]): string {
  switch (status) {
    case "queued": return "waiting for a concurrency slot";
    case "running": return "working";
    case "ready": return "result ready for parent integration";
    case "integrating": return "integrating result into parent";
    case "integrated": return "result integrated";
    case "completed": return "returned to parent";
    case "failed": return "failed";
    case "cancelled": return "cancelled";
  }
}

function elapsedLabel(createdAt: string, updatedAt: string): string | undefined {
  const elapsed = Date.parse(updatedAt) - Date.parse(createdAt);
  if (!Number.isFinite(elapsed) || elapsed < 0) return undefined;
  if (elapsed < 1_000) return "<1s";
  if (elapsed < 60_000) return `${Math.round(elapsed / 1_000)}s`;
  return `${Math.floor(elapsed / 60_000)}m ${Math.round((elapsed % 60_000) / 1_000)}s`;
}

function usageLabel(agent: AgentCardState): string | undefined {
  const total = agent.usage?.totalTokens
    ?? ((agent.usage?.inputTokens ?? 0) + (agent.usage?.outputTokens ?? 0));
  if (!total) return undefined;
  return total >= 1000 ? `${(total / 1000).toFixed(1)}k tokens` : `${total} tokens`;
}

function isTerminalForPreview(status: AgentCardState["status"]): boolean {
  return status === "ready" || status === "integrating" || status === "integrated" || status === "completed" || status === "failed";
}
