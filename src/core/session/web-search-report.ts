import type {
  WebSearchCallRecord,
  WebSearchCitation,
  WebSearchReport,
} from "../../providers/shared/types";

/** Restore the portable audit floor while filtering malformed optional entries. */
export function parseReplayableWebSearch(value: unknown): WebSearchReport | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  if (typeof source.provider !== "string" || source.provider.length === 0) return undefined;
  const queries = Array.isArray(source.queries)
    ? source.queries.filter((query): query is string => typeof query === "string" && query.length > 0)
    : [];
  if (queries.length === 0) return undefined;
  const citations = Array.isArray(source.citations)
    ? source.citations.flatMap((entry): WebSearchCitation[] => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const citation = entry as Record<string, unknown>;
      if (typeof citation.url !== "string" || typeof citation.title !== "string") return [];
      return [{
        url: citation.url,
        title: citation.title,
        ...(typeof citation.startIndex === "number" ? { startIndex: citation.startIndex } : {}),
        ...(typeof citation.endIndex === "number" ? { endIndex: citation.endIndex } : {}),
        ...(typeof citation.summary === "string" ? { summary: citation.summary } : {}),
        ...(typeof citation.siteName === "string" ? { siteName: citation.siteName } : {}),
        ...(typeof citation.publishTime === "string" ? { publishTime: citation.publishTime } : {}),
      }];
    })
    : undefined;
  const calls = Array.isArray(source.calls)
    ? source.calls.flatMap((entry): WebSearchCallRecord[] => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const call = entry as Record<string, unknown>;
      if (typeof call.id !== "string" || typeof call.status !== "string"
        || !call.action || typeof call.action !== "object" || Array.isArray(call.action)) return [];
      return [{ id: call.id, status: call.status, action: call.action as Record<string, unknown> }];
    })
    : undefined;
  return {
    provider: source.provider,
    queries,
    ...(citations && citations.length > 0 ? { citations } : {}),
    ...(calls && calls.length > 0 ? { calls } : {}),
  };
}
