import type { ToolCall, ToolResult, WebToolEvent } from "../types";
import {
  clampInteger,
  enumValue,
  mapOrCrawlRequest,
  normalizeCrawlResults,
  normalizeUrl,
  normalizeUrlList,
  parseArgs,
} from "./normalization";
import { fail, loadTavilyApiKey, tavilyError, tavilyHeaders, tavilyMissing } from "./tavily-client";
import type { FetchLike, TavilyMapResponse, WebCrawlArgs, WebMapArgs } from "./types";

type TraversalOptions = {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
};

export async function executeWebMapTool(
  call: ToolCall,
  options: TraversalOptions = {},
): Promise<ToolResult> {
  try {
    const args = parseArgs<WebMapArgs>(call.arguments);
    const url = normalizeUrl(args.url, "web_map");
    const request = mapOrCrawlRequest(args, { maxBreadth: 20, limit: 20 });
    const apiKey = await loadTavilyApiKey(options.env ?? process.env);
    if (!apiKey) return tavilyMissing(call, "map");

    const response = await (options.fetchImpl ?? fetch)("https://api.tavily.com/map", {
      method: "POST",
      headers: tavilyHeaders(apiKey),
      body: JSON.stringify({
        url,
        ...request,
      }),
    });

    if (!response.ok) return fail(call, await tavilyError("map", response));

    const payload = await response.json() as TavilyMapResponse;
    const urls = normalizeUrlList(payload.results);
    const content = JSON.stringify({
      url,
      results: urls,
      fetchedAt: new Date().toISOString(),
    });
    const webEvent: WebToolEvent = {
      kind: "web_map",
      provider: "tavily",
      url,
      resultCount: urls.length,
      urls,
    };
    return { callId: call.id, name: call.name, ok: true, content, webEvent };
  } catch (error) {
    return fail(call, error instanceof Error ? error.message : String(error));
  }
}

export async function executeWebCrawlTool(
  call: ToolCall,
  options: TraversalOptions = {},
): Promise<ToolResult> {
  try {
    const args = parseArgs<WebCrawlArgs>(call.arguments);
    const url = normalizeUrl(args.url, "web_crawl");
    const maxChars = clampInteger(args.maxChars, 12_000, 1, 30_000);
    const extractDepth = enumValue(args.extractDepth, ["basic", "advanced"], "basic");
    const format = enumValue(args.format, ["markdown", "text"], "markdown");
    const request = mapOrCrawlRequest(args, { maxBreadth: 10, limit: 10 });
    const apiKey = await loadTavilyApiKey(options.env ?? process.env);
    if (!apiKey) return tavilyMissing(call, "crawl");

    const response = await (options.fetchImpl ?? fetch)("https://api.tavily.com/crawl", {
      method: "POST",
      headers: tavilyHeaders(apiKey),
      body: JSON.stringify({
        url,
        ...request,
        extract_depth: extractDepth,
        include_images: false,
        include_favicon: false,
        format,
        include_usage: false,
      }),
    });

    if (!response.ok) return fail(call, await tavilyError("crawl", response));

    const payload = await response.json() as TavilyMapResponse;
    const results = normalizeCrawlResults(payload.results, maxChars);
    const content = JSON.stringify({
      url,
      results,
      truncated: results.some((result) => result.truncated),
      fetchedAt: new Date().toISOString(),
    });
    const webEvent: WebToolEvent = {
      kind: "web_crawl",
      provider: "tavily",
      url,
      pageCount: results.length,
      urls: results.map((result) => result.url),
      chars: results.reduce((sum, result) => sum + result.content.length, 0),
      truncated: results.some((result) => result.truncated),
    };
    return { callId: call.id, name: call.name, ok: true, content, webEvent };
  } catch (error) {
    return fail(call, error instanceof Error ? error.message : String(error));
  }
}
