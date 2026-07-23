import type { ToolCall, ToolResult, WebToolEvent } from "../types";
import {
  clampInteger,
  enumValue,
  normalizeExtractResults,
  normalizeFailedResults,
  normalizeUrls,
  optionalString,
  parseArgs,
} from "./normalization";
import { fail, loadTavilyApiKey, tavilyError, tavilyHeaders, tavilyMissing } from "./tavily-client";
import type { FetchLike, TavilyExtractResponse, WebFetchArgs } from "./types";

export async function executeWebFetchTool(
  call: ToolCall,
  options: {
    env?: NodeJS.ProcessEnv;
    fetchImpl?: FetchLike;
  } = {},
): Promise<ToolResult> {
  try {
    const args = parseArgs<WebFetchArgs>(call.arguments);
    const urls = normalizeUrls(args.urls ?? (args.url ? [args.url] : undefined), "web_fetch", 5);
    const maxChars = clampInteger(args.maxChars, 6_000, 1, 12_000);
    const extractDepth = enumValue(args.extractDepth, ["basic", "advanced"], "basic");
    const format = enumValue(args.format, ["markdown", "text"], "markdown");
    const query = optionalString(args.query);
    const apiKey = await loadTavilyApiKey(options.env ?? process.env);
    if (!apiKey) return tavilyMissing(call, "fetch");

    const response = await (options.fetchImpl ?? fetch)("https://api.tavily.com/extract", {
      method: "POST",
      headers: tavilyHeaders(apiKey),
      body: JSON.stringify({
        urls,
        extract_depth: extractDepth,
        include_images: false,
        include_favicon: false,
        format,
        include_usage: false,
        ...(query ? { query } : {}),
      }),
    });

    if (!response.ok) return fail(call, await tavilyError("fetch", response));

    const payload = await response.json() as TavilyExtractResponse;
    const results = normalizeExtractResults(payload.results, maxChars);
    if (results.length === 0) {
      const failed = normalizeFailedResults(payload.failed_results);
      return fail(call, `Tavily fetch returned no content${failed ? `: ${failed}` : "."}`);
    }
    const content = JSON.stringify({
      results,
      truncated: results.some((result) => result.truncated),
      fetchedAt: new Date().toISOString(),
    });
    const webEvent: WebToolEvent = {
      kind: "web_fetch",
      provider: "tavily",
      urls: results.map((result) => result.url),
      chars: results.reduce((sum, result) => sum + result.content.length, 0),
      truncated: results.some((result) => result.truncated),
    };
    return { callId: call.id, name: call.name, ok: true, content, webEvent };
  } catch (error) {
    return fail(call, error instanceof Error ? error.message : String(error));
  }
}
