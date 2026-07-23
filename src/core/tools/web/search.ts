import type { ToolCall, ToolResult, WebToolEvent } from "../types";
import {
  clampInteger,
  enumValue,
  normalizeDomains,
  normalizeNonEmptyString,
  normalizeSearchResults,
  optionalDate,
  optionalEnumValue,
  optionalString,
  parseArgs,
} from "./normalization";
import { fail, loadTavilyApiKey, tavilyError, tavilyHeaders, tavilyMissing } from "./tavily-client";
import type { FetchLike, TavilySearchResponse, WebSearchArgs } from "./types";

export async function executeWebSearchTool(
  call: ToolCall,
  options: {
    env?: NodeJS.ProcessEnv;
    fetchImpl?: FetchLike;
  } = {},
): Promise<ToolResult> {
  try {
    const args = parseArgs<WebSearchArgs>(call.arguments);
    const query = normalizeNonEmptyString(args.query, "web_search requires a non-empty query string.");
    const maxResults = clampInteger(args.maxResults, 5, 1, 10);
    const allowedDomains = normalizeDomains(args.allowedDomains, 10);
    const blockedDomains = normalizeDomains(args.blockedDomains, 10);
    const searchDepth = enumValue(args.searchDepth, ["basic", "advanced", "fast", "ultra-fast"], "basic");
    const topic = enumValue(args.topic, ["general", "news", "finance"], "general");
    const timeRange = optionalEnumValue(args.timeRange, ["day", "week", "month", "year"]);
    const startDate = optionalDate(args.startDate, "startDate");
    const endDate = optionalDate(args.endDate, "endDate");
    const country = optionalString(args.country);
    const apiKey = await loadTavilyApiKey(options.env ?? process.env);
    if (!apiKey) return tavilyMissing(call, "search");

    const response = await (options.fetchImpl ?? fetch)("https://api.tavily.com/search", {
      method: "POST",
      headers: tavilyHeaders(apiKey),
      body: JSON.stringify({
        query,
        search_depth: searchDepth,
        max_results: maxResults,
        topic,
        include_answer: false,
        include_raw_content: false,
        include_images: false,
        include_image_descriptions: false,
        include_favicon: false,
        ...(timeRange ? { time_range: timeRange } : {}),
        ...(startDate ? { start_date: startDate } : {}),
        ...(endDate ? { end_date: endDate } : {}),
        ...(country && topic === "general" ? { country } : {}),
        ...(allowedDomains.length > 0 ? { include_domains: allowedDomains } : {}),
        ...(blockedDomains.length > 0 ? { exclude_domains: blockedDomains } : {}),
      }),
    });

    if (!response.ok) return fail(call, await tavilyError("search", response));

    const payload = await response.json() as TavilySearchResponse;
    const results = normalizeSearchResults(payload.results);
    const content = JSON.stringify({
      query,
      results,
      fetchedAt: new Date().toISOString(),
    });
    const webEvent: WebToolEvent = {
      kind: "web_search",
      provider: "tavily",
      query,
      resultCount: results.length,
      urls: results.map((result) => result.url),
    };
    return { callId: call.id, name: call.name, ok: true, content, webEvent };
  } catch (error) {
    return fail(call, error instanceof Error ? error.message : String(error));
  }
}
