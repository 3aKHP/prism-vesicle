export function renderResumedToolResultSummary(content: string): string {
  const parsed = parseJsonObject(content);
  const ok = typeof parsed?.ok === "boolean" ? parsed.ok : undefined;
  const result = typeof parsed?.result === "string" ? parsed.result : content;
  const status = ok === undefined ? "tool result" : ok ? "ok tool" : "failed tool";
  return `${status}: ${summarizeToolContent(result)}`;
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
