import type { ToolCall, ToolResult, WebToolEvent } from "../types";
import {
  clampInteger,
  enumValue,
  normalizeDomains,
  normalizeNonEmptyString,
  normalizeSources,
  parseArgs,
  stringOrUndefined,
} from "./normalization";
import { fail, loadTavilyApiKey, tavilyError, tavilyHeaders, tavilyMissing, truncate } from "./tavily-client";
import type { FetchLike, TavilyResearchQueued, TavilyResearchResponse, WebResearchArgs } from "./types";

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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
