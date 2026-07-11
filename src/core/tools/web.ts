import { loadUserConfigEnvironment } from "../../config/providers";
import type { ToolCall, ToolDefinition, ToolResult, WebToolEvent } from "./types";

type FetchLike = typeof fetch;

type SearchDepth = "basic" | "advanced" | "fast" | "ultra-fast";
type ExtractDepth = "basic" | "advanced";
type WebContentFormat = "markdown" | "text";
type TimeRange = "day" | "week" | "month" | "year";
type SearchTopic = "general" | "news" | "finance";
type ResearchModel = "mini" | "pro" | "auto";
type CitationFormat = "numbered" | "mla" | "apa" | "chicago";
type ResearchOutputLength = "short" | "standard" | "long";

type WebSearchArgs = {
  query: string;
  maxResults?: number;
  searchDepth?: SearchDepth;
  topic?: SearchTopic;
  timeRange?: TimeRange;
  startDate?: string;
  endDate?: string;
  country?: string;
  allowedDomains?: string[];
  blockedDomains?: string[];
};

type WebFetchArgs = {
  url?: string;
  urls?: string[];
  maxChars?: number;
  extractDepth?: ExtractDepth;
  format?: WebContentFormat;
  query?: string;
};

type WebMapArgs = {
  url: string;
  instructions?: string;
  maxDepth?: number;
  maxBreadth?: number;
  limit?: number;
  allowExternal?: boolean;
  allowedDomains?: string[];
  allowedPaths?: string[];
};

type WebCrawlArgs = WebMapArgs & {
  maxChars?: number;
  extractDepth?: ExtractDepth;
  format?: WebContentFormat;
};

type WebResearchArgs = {
  input: string;
  model?: ResearchModel;
  citationFormat?: CitationFormat;
  outputLength?: ResearchOutputLength;
  includeDomains?: string[];
  excludeDomains?: string[];
  maxChars?: number;
  timeoutSeconds?: number;
};

type TavilyResult = {
  title?: unknown;
  url?: unknown;
  content?: unknown;
  raw_content?: unknown;
  score?: unknown;
  published_date?: unknown;
  favicon?: unknown;
};

type TavilySearchResponse = {
  query?: unknown;
  results?: unknown;
};

type TavilyExtractResult = {
  url?: unknown;
  raw_content?: unknown;
  favicon?: unknown;
};

type TavilyExtractResponse = {
  results?: unknown;
  failed_results?: unknown;
};

type TavilyMapResponse = {
  base_url?: unknown;
  results?: unknown;
};

type TavilyResearchQueued = {
  request_id?: unknown;
  status?: unknown;
};

type TavilyResearchResponse = {
  request_id?: unknown;
  status?: unknown;
  content?: unknown;
  sources?: unknown;
};

const tavilyHeaders = (apiKey: string) => ({
  "Authorization": `Bearer ${apiKey}`,
  "Content-Type": "application/json",
});

export const webSearchToolDefinition: ToolDefinition = {
  type: "function",
  function: {
    name: "web_search",
    description: "Search the live web through Tavily and return cited results for research. Use web_fetch for full page content and file tools to persist synthesized notes under source_materials/.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query. Be specific enough to retrieve source material, not a generic topic label.",
        },
        maxResults: {
          type: "number",
          description: "Maximum result count. Defaults to 5 and is capped at 10.",
        },
        searchDepth: {
          type: "string",
          enum: ["basic", "advanced", "fast", "ultra-fast"],
          description: "Latency/relevance tradeoff. Defaults to basic; use advanced for high-confidence evidence gathering.",
        },
        topic: {
          type: "string",
          enum: ["general", "news", "finance"],
          description: "Search category. Defaults to general.",
        },
        timeRange: {
          type: "string",
          enum: ["day", "week", "month", "year"],
          description: "Optional recency filter.",
        },
        startDate: {
          type: "string",
          description: "Optional YYYY-MM-DD lower date bound.",
        },
        endDate: {
          type: "string",
          description: "Optional YYYY-MM-DD upper date bound.",
        },
        country: {
          type: "string",
          description: "Optional country boost for general searches, such as united states or japan.",
        },
        allowedDomains: {
          type: "array",
          items: { type: "string" },
          description: "Optional domains to restrict Tavily search to, such as example.com.",
        },
        blockedDomains: {
          type: "array",
          items: { type: "string" },
          description: "Optional domains to exclude from Tavily search.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
};

export const webFetchToolDefinition: ToolDefinition = {
  type: "function",
  function: {
    name: "web_fetch",
    description: "Fetch and extract readable content from one or more URLs through Tavily Extract. Use this after web_search or web_map identifies sources worth reading.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Single HTTP or HTTPS URL to fetch. Use urls for batches.",
        },
        urls: {
          type: "array",
          items: { type: "string" },
          description: "HTTP or HTTPS URLs to fetch. Capped at 5 per call.",
        },
        maxChars: {
          type: "number",
          description: "Maximum extracted content characters to return across all URLs. Defaults to 6000 and is capped at 12000.",
        },
        extractDepth: {
          type: "string",
          enum: ["basic", "advanced"],
          description: "Extraction depth. Defaults to basic; advanced may retrieve tables or embedded content with higher latency/cost.",
        },
        format: {
          type: "string",
          enum: ["markdown", "text"],
          description: "Output format. Defaults to markdown.",
        },
        query: {
          type: "string",
          description: "Optional relevance query for chunk reranking during extraction.",
        },
      },
      additionalProperties: false,
    },
  },
};

export const webMapToolDefinition: ToolDefinition = {
  type: "function",
  function: {
    name: "web_map",
    description: "Map a website's URL structure through Tavily before deciding which pages to fetch or crawl.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "HTTP or HTTPS root URL to map." },
        instructions: { type: "string", description: "Optional natural-language guidance for which pages to discover." },
        maxDepth: { type: "number", description: "Maximum link depth. Defaults to 1 and is capped at 3." },
        maxBreadth: { type: "number", description: "Maximum links to follow per page. Defaults to 20 and is capped at 50." },
        limit: { type: "number", description: "Maximum URLs to return. Defaults to 20 and is capped at 100." },
        allowExternal: { type: "boolean", description: "Whether to include external links. Defaults to false." },
        allowedDomains: { type: "array", items: { type: "string" }, description: "Optional domain regexes to include." },
        allowedPaths: { type: "array", items: { type: "string" }, description: "Optional path regexes to include, such as /docs/.*." },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
};

export const webCrawlToolDefinition: ToolDefinition = {
  type: "function",
  function: {
    name: "web_crawl",
    description: "Crawl and extract bounded content from multiple pages on a website through Tavily. Prefer web_map first when the useful paths are unknown.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "HTTP or HTTPS root URL to crawl." },
        instructions: { type: "string", description: "Optional natural-language guidance for which pages to return." },
        maxDepth: { type: "number", description: "Maximum link depth. Defaults to 1 and is capped at 3." },
        maxBreadth: { type: "number", description: "Maximum links to follow per page. Defaults to 10 and is capped at 30." },
        limit: { type: "number", description: "Maximum pages to crawl. Defaults to 10 and is capped at 30." },
        allowExternal: { type: "boolean", description: "Whether to include external links. Defaults to false." },
        allowedDomains: { type: "array", items: { type: "string" }, description: "Optional domain regexes to include." },
        allowedPaths: { type: "array", items: { type: "string" }, description: "Optional path regexes to include, such as /docs/.*." },
        maxChars: { type: "number", description: "Maximum extracted content characters to return across all pages. Defaults to 12000 and is capped at 30000." },
        extractDepth: { type: "string", enum: ["basic", "advanced"], description: "Extraction depth. Defaults to basic." },
        format: { type: "string", enum: ["markdown", "text"], description: "Output format. Defaults to markdown." },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
};

export const webResearchToolDefinition: ToolDefinition = {
  type: "function",
  function: {
    name: "web_research",
    description: "Run a bounded Tavily Research task that searches, analyzes sources, and returns a cited synthesis. Use for broad comparisons or decision-ready reports.",
    parameters: {
      type: "object",
      properties: {
        input: { type: "string", description: "Research task or question to investigate." },
        model: { type: "string", enum: ["mini", "pro", "auto"], description: "Research model. Defaults to mini; use pro only for broad multi-angle research." },
        citationFormat: { type: "string", enum: ["numbered", "mla", "apa", "chicago"], description: "Citation style. Defaults to numbered." },
        outputLength: { type: "string", enum: ["short", "standard", "long"], description: "Target response size. Defaults to standard." },
        includeDomains: { type: "array", items: { type: "string" }, description: "Soft preferred source domains. Capped at 20." },
        excludeDomains: { type: "array", items: { type: "string" }, description: "Source domains to avoid. Capped at 20." },
        maxChars: { type: "number", description: "Maximum report characters returned. Defaults to 12000 and is capped at 30000." },
        timeoutSeconds: { type: "number", description: "Maximum time to wait for the research task. Defaults to 45 and is capped at 120." },
      },
      required: ["input"],
      additionalProperties: false,
    },
  },
};

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

export async function executeWebMapTool(
  call: ToolCall,
  options: {
    env?: NodeJS.ProcessEnv;
    fetchImpl?: FetchLike;
  } = {},
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
  options: {
    env?: NodeJS.ProcessEnv;
    fetchImpl?: FetchLike;
  } = {},
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

export async function executeWebResearchTool(
  call: ToolCall,
  options: {
    env?: NodeJS.ProcessEnv;
    fetchImpl?: FetchLike;
    pollIntervalMs?: number;
  } = {},
): Promise<ToolResult> {
  try {
    const args = parseArgs<WebResearchArgs>(call.arguments);
    const input = normalizeNonEmptyString(args.input, "web_research requires a non-empty input string.");
    const model = enumValue(args.model, ["mini", "pro", "auto"], "mini");
    const citationFormat = enumValue(args.citationFormat, ["numbered", "mla", "apa", "chicago"], "numbered");
    const outputLength = enumValue(args.outputLength, ["short", "standard", "long"], "standard");
    const includeDomains = normalizeDomains(args.includeDomains, 20);
    const excludeDomains = normalizeDomains(args.excludeDomains, 20);
    const maxChars = clampInteger(args.maxChars, 12_000, 1, 30_000);
    const timeoutMs = clampInteger(args.timeoutSeconds, 45, 5, 120) * 1000;
    const pollIntervalMs = options.pollIntervalMs ?? 2_000;
    const apiKey = await loadTavilyApiKey(options.env ?? process.env);
    if (!apiKey) return tavilyMissing(call, "research");

    const fetchImpl = options.fetchImpl ?? fetch;
    const queuedResponse = await fetchImpl("https://api.tavily.com/research", {
      method: "POST",
      headers: tavilyHeaders(apiKey),
      body: JSON.stringify({
        input,
        model,
        stream: false,
        citation_format: citationFormat,
        output_length: outputLength,
        ...(includeDomains.length > 0 ? { include_domains: includeDomains } : {}),
        ...(excludeDomains.length > 0 ? { exclude_domains: excludeDomains } : {}),
      }),
    });

    if (!queuedResponse.ok) return fail(call, await tavilyError("research", queuedResponse));

    const queued = await queuedResponse.json() as TavilyResearchQueued;
    const requestId = stringOrUndefined(queued.request_id);
    if (!requestId) return fail(call, "Tavily research did not return a request_id.");

    const started = Date.now();
    while (Date.now() - started <= timeoutMs) {
      const resultResponse = await fetchImpl(`https://api.tavily.com/research/${encodeURIComponent(requestId)}`, {
        method: "GET",
        headers: tavilyHeaders(apiKey),
      });
      if (resultResponse.status === 202) {
        await delay(pollIntervalMs);
        continue;
      }
      if (!resultResponse.ok) return fail(call, await tavilyError("research", resultResponse));

      const payload = await resultResponse.json() as TavilyResearchResponse;
      const status = stringOrUndefined(payload.status);
      if (status === "failed") return fail(call, `Tavily research failed for request ${requestId}.`);
      if (status !== "completed") {
        await delay(pollIntervalMs);
        continue;
      }

      const fullContent = typeof payload.content === "string" ? payload.content : JSON.stringify(payload.content ?? "");
      const report = truncate(fullContent, maxChars);
      const sources = normalizeSources(payload.sources);
      const truncated = report.length < fullContent.length;
      const content = JSON.stringify({
        requestId,
        input,
        report,
        sources,
        truncated,
        fetchedAt: new Date().toISOString(),
      });
      const webEvent: WebToolEvent = {
        kind: "web_research",
        provider: "tavily",
        input,
        requestId,
        sourceCount: sources.length,
        urls: sources.map((source) => source.url),
        chars: report.length,
        truncated,
      };
      return { callId: call.id, name: call.name, ok: true, content, webEvent };
    }

    return fail(call, `Tavily research timed out after ${Math.round(timeoutMs / 1000)}s. Request id: ${requestId}.`);
  } catch (error) {
    return fail(call, error instanceof Error ? error.message : String(error));
  }
}

async function loadTavilyApiKey(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const loaded = await loadUserConfigEnvironment(env);
  return loaded.effectiveEnv.TAVILY_API_KEY;
}

function parseArgs<T>(raw: string): T {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("arguments must be a JSON object");
    }
    return parsed as T;
  } catch (error) {
    if (error instanceof Error && error.message === "arguments must be a JSON object") throw error;
    throw new Error(`Invalid tool arguments: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function mapOrCrawlRequest(args: WebMapArgs, defaults: { maxBreadth: number; limit: number }): Record<string, unknown> {
  const instructions = optionalString(args.instructions);
  const allowedDomains = normalizeRegexList(args.allowedDomains, 10);
  const allowedPaths = normalizeRegexList(args.allowedPaths, 10);
  return {
    max_depth: clampInteger(args.maxDepth, 1, 1, 3),
    max_breadth: clampInteger(args.maxBreadth, defaults.maxBreadth, 1, defaults.maxBreadth === 20 ? 50 : 30),
    limit: clampInteger(args.limit, defaults.limit, 1, defaults.limit === 20 ? 100 : 30),
    allow_external: args.allowExternal === true,
    ...(instructions ? { instructions } : {}),
    ...(allowedDomains.length > 0 ? { select_domains: allowedDomains } : {}),
    ...(allowedPaths.length > 0 ? { select_paths: allowedPaths } : {}),
    include_usage: false,
  };
}

function normalizeNonEmptyString(value: unknown, message: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(message);
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeUrl(value: unknown, toolName: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${toolName} requires a non-empty url string.`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error(`${toolName} requires a valid URL, got "${value}".`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${toolName} supports only http:// or https:// URLs, got "${parsed.protocol}".`);
  }
  return parsed.toString();
}

function normalizeUrls(value: unknown, toolName: string, max: number): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${toolName} requires at least one URL.`);
  }
  return value.slice(0, max).map((item) => normalizeUrl(item, toolName));
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = typeof value === "number" ? value : fallback;
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(numeric)));
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? value as T : fallback;
}

function optionalEnumValue<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return allowed.includes(value as T) ? value as T : undefined;
}

function optionalDate(value: unknown, label: string): string | undefined {
  if (value == null || value === "") return undefined;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${label} must use YYYY-MM-DD format.`);
  }
  return value;
}

function normalizeDomains(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => typeof item === "string" ? item.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "") : "")
    .filter((item) => item.length > 0)
    .slice(0, max);
}

function normalizeRegexList(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => typeof item === "string" ? item.trim() : "")
    .filter((item) => item.length > 0)
    .slice(0, max);
}

function normalizeSearchResults(value: unknown): Array<{ title: string; url: string; snippet: string; score?: number; publishedAt?: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const result = item as TavilyResult;
    const url = typeof result.url === "string" ? result.url : "";
    if (!url) return [];
    const score = typeof result.score === "number" && Number.isFinite(result.score) ? result.score : undefined;
    const publishedAt = typeof result.published_date === "string" && result.published_date ? result.published_date : undefined;
    return [{
      title: typeof result.title === "string" && result.title ? result.title : url,
      url,
      snippet: typeof result.content === "string" ? result.content : "",
      ...(score !== undefined ? { score } : {}),
      ...(publishedAt ? { publishedAt } : {}),
    }];
  });
}

function normalizeExtractResults(value: unknown, maxChars: number): Array<{ url: string; content: string; truncated: boolean }> {
  if (!Array.isArray(value)) return [];
  let remaining = maxChars;
  const results: Array<{ url: string; content: string; truncated: boolean }> = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || remaining <= 0) continue;
    const result = item as TavilyExtractResult;
    const url = typeof result.url === "string" ? result.url : "";
    const fullContent = typeof result.raw_content === "string" ? result.raw_content : "";
    if (!url || !fullContent) continue;
    const content = truncate(fullContent, remaining);
    results.push({ url, content, truncated: content.length < fullContent.length });
    remaining -= content.length;
  }
  return results;
}

function normalizeUrlList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function normalizeCrawlResults(value: unknown, maxChars: number): Array<{ url: string; content: string; truncated: boolean }> {
  if (!Array.isArray(value)) return [];
  let remaining = maxChars;
  const results: Array<{ url: string; content: string; truncated: boolean }> = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || remaining <= 0) continue;
    const result = item as TavilyResult;
    const url = typeof result.url === "string" ? result.url : "";
    const fullContent = typeof result.raw_content === "string" ? result.raw_content : "";
    if (!url) continue;
    const content = truncate(fullContent, remaining);
    results.push({ url, content, truncated: content.length < fullContent.length });
    remaining -= content.length;
  }
  return results;
}

function normalizeSources(value: unknown): Array<{ title: string; url: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const source = item as TavilyResult;
    const url = typeof source.url === "string" ? source.url : "";
    if (!url) return [];
    return [{ title: typeof source.title === "string" && source.title ? source.title : url, url }];
  });
}

function normalizeFailedResults(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  return truncate(JSON.stringify(value), 500);
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function tavilyMissing(call: ToolCall, label: string): ToolResult {
  return fail(call, `Tavily web ${label} is not configured. Set TAVILY_API_KEY in the user-level prism-vesicle .env file or process environment.`);
}

async function tavilyError(label: string, response: Response): Promise<string> {
  const body = await response.text().catch(() => "");
  return `Tavily ${label} failed (${response.status} ${response.statusText})${body ? `: ${truncate(body, 500)}` : "."}`;
}

function fail(call: ToolCall, content: string): ToolResult {
  return { callId: call.id, name: call.name, ok: false, content };
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
