export type ToolCallSummary = {
  name: string;
  arguments?: string;
};

export function renderAssistantToolTurn(content: string, toolCalls: ToolCallSummary[]): string {
  const lines: string[] = [];
  if (content.trim()) lines.push(content.trim());
  if (toolCalls.length > 0) {
    lines.push("");
    lines.push("Tool calls:");
    for (const call of toolCalls) lines.push(`- ${toolCallLabel(call.name, call.arguments)}`);
  }
  return lines.join("\n");
}

export function renderToolCallSummary(name: string, argumentsJson: string): string {
  return `-> ${toolCallLabel(name, argumentsJson)}`;
}

export function renderToolResultSummary(name: string, ok: boolean, content: string): string {
  return `${ok ? "ok" : "failed"} ${name}: ${summarizeToolContent(content)}`;
}

export function renderResumedToolResultSummary(content: string): string {
  const parsed = parseJsonObject(content);
  const ok = typeof parsed?.ok === "boolean" ? parsed.ok : undefined;
  const result = typeof parsed?.result === "string" ? parsed.result : content;
  const status = ok === undefined ? "tool result" : ok ? "ok tool" : "failed tool";
  return `${status}: ${summarizeToolContent(result)}`;
}

function toolCallLabel(name: string, argumentsJson?: string): string {
  const parsed = parseJsonObject(argumentsJson);
  const parts = [name];
  if (typeof parsed?.path === "string" && parsed.path.length > 0) {
    parts.push(parsed.path);
  } else if (typeof parsed?.gate === "string" && parsed.gate.length > 0) {
    parts.push(`gate=${parsed.gate}`);
  }
  if (typeof parsed?.recursive === "boolean" && parsed.recursive) {
    parts.push("(recursive)");
  }
  if (typeof parsed?.content === "string") {
    parts.push(`(${parsed.content.length} chars)`);
  }
  return parts.join(" ");
}

function summarizeToolContent(content: string): string {
  const singleLine = content.replace(/\s+/g, " ").trim();
  if (!singleLine) return "(empty)";
  return truncateLine(singleLine, 120);
}

function parseJsonObject(value: string | undefined): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  return null;
}

function truncateLine(value: string, width: number): string {
  const limit = Math.max(8, width);
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 3)}...`;
}
