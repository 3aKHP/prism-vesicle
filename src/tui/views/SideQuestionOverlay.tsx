// `/btw` full-area overlay. While active it visually replaces the message
// stream and composer; the main TUI state keeps running underneath. Presentational
// only — exchange state, scroll offset, and key handling are owned by the
// side-question controller and passed in as props.

import { TextAttributes } from "@opentui/core";
import { palette } from "../theme";
import { truncateLine, wrapDisplayLines } from "../format";
import type { SideQuestionExchange } from "../side-question-controller";

export type SideQuestionOverlayProps = {
  exchange: SideQuestionExchange | undefined;
  index: number;
  total: number;
  mainStatus: string;
  scrollOffset: number;
  width: number;
  height: number;
};

const FOOTER_HINT = "Esc close · ↑/↓ scroll · ←/→ exchanges · c copy · x clear";

export function SideQuestionOverlay(props: SideQuestionOverlayProps) {
  const innerWidth = () => Math.max(8, props.width - 4);
  const title = () => {
    const count = props.total > 0 ? `${props.index + 1}/${props.total}` : "—";
    return `BTW · ${count}`;
  };

  const questionLines = () => wrapDisplayLines(`Q: ${props.exchange?.question ?? ""}`, innerWidth()).slice(0, 2);

  const answerRows = () => {
    const exchange = props.exchange;
    const budget = answerBudget();
    if (!exchange) return [] as string[];
    if (exchange.phase === "loading") {
      return [loadingText(exchange.answer)];
    }
    if (exchange.phase === "error") return wrapDisplayLines(`Error: ${exchange.error ?? "unknown"}`, innerWidth());
    if (exchange.phase === "cancelled") return ["Side question cancelled."];
    const lines = wrapDisplayLines(exchange.answer, innerWidth());
    const usage = exchange.usage ? usageLine(exchange.usage) : undefined;
    const withUsage = usage ? [...lines, "", usage] : lines;
    const maxOffset = Math.max(0, withUsage.length - budget);
    const offset = Math.min(props.scrollOffset, maxOffset);
    return withUsage.slice(offset, offset + budget);
  };

  const answerBudget = () => {
    // title(1) + question(≤2) + footer(1) + borders(2) + padding slack.
    const reserved = 1 + Math.min(2, questionLines().length) + 1 + 2;
    return Math.max(3, props.height - reserved);
  };

  return (
    <box flexDirection="column" width="100%" height="100%" border borderColor={palette.panelBorder} paddingX={1}>
      <box flexDirection="row" height={1}>
        <text content={title()} fg={palette.brand} attributes={TextAttributes.BOLD} wrapMode="none" />
        <text content={`  ${props.mainStatus}`} fg={palette.textMuted} wrapMode="none" />
      </box>
      {questionLines().map((line) => (
        <box height={1}>
          <text content={truncateLine(line, innerWidth())} fg={palette.user} wrapMode="none" />
        </box>
      ))}
      <box flexDirection="column" flexGrow={1}>
        {answerRows().map((row) => (
          <box height={1}>
            <text
              content={truncateLine(row, innerWidth())}
              fg={props.exchange?.phase === "error" ? palette.error : palette.assistant}
              wrapMode="none"
            />
          </box>
        ))}
      </box>
      <box height={1}>
        <text content={truncateLine(FOOTER_HINT, innerWidth())} fg={palette.textDim} wrapMode="none" />
      </box>
    </box>
  );
}

function loadingText(answer: string): string {
  const partial = answer.trim();
  return partial.length > 0 ? `${partial} …` : "Thinking…";
}

function usageLine(usage: SideQuestionExchange["usage"]): string {
  if (!usage) return "";
  const parts: string[] = [];
  if (typeof usage.inputTokens === "number") parts.push(`↑${usage.inputTokens}`);
  if (typeof usage.outputTokens === "number") parts.push(`↓${usage.outputTokens}`);
  return parts.length > 0 ? `_tokens ${parts.join(" ")}_` : "";
}
