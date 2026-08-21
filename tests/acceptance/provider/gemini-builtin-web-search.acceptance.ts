import { expect, test } from "bun:test";
import { loadConfigForSelection } from "../../../src/config/providers";
import type { VesicleConfig } from "../../../src/config/env";
import { createProvider } from "../../../src/providers";
import { toGeminiGenerateContentBody } from "../../../src/providers/gemini-generate-content/adapter";
import type { ProviderStreamEvent, VesicleRequest } from "../../../src/providers/shared/types";
import { summarize } from "./support";

const providerEnv = "BUN_E2E_GEMINI_WEB_SEARCH_PROVIDER";
const modelEnv = "BUN_E2E_GEMINI_WEB_SEARCH_MODEL";

async function resolveGeminiWebSearchAcceptance(): Promise<{ config?: VesicleConfig; reason: string }> {
  const providerId = process.env[providerEnv];
  if (process.env.BUN_E2E_REAL_PROVIDER !== "1") return { reason: "BUN_E2E_REAL_PROVIDER=1 is not set" };
  if (!providerId) return { reason: `${providerEnv} is not set` };
  try {
    const model = process.env[modelEnv];
    const config = await loadConfigForSelection({ provider: providerId, ...(model ? { model } : {}) });
    if (config.provider !== "gemini-generate-content") {
      return { reason: `${providerId} is not configured with protocol gemini-generate-content` };
    }
    if (!config.apiKey) return { reason: `${config.apiKeyLabel ?? "provider API key"} is missing` };
    if (config.capabilities?.builtinWebSearch !== true) {
      return { reason: `${providerId}/${config.model} does not declare capabilities.builtinWebSearch: true` };
    }
    return { config, reason: "ok" };
  } catch {
    return { reason: "provider configuration could not be loaded" };
  }
}

const resolved = await resolveGeminiWebSearchAcceptance();
if (!resolved.config) console.log(`[acceptance:gemini-builtin-web-search] unavailable: ${resolved.reason}`);
const liveTest: typeof test = resolved.config ? test : test.skip;
const label = resolved.config ? `${resolved.config.providerId}/${resolved.config.model}` : `skipped: ${resolved.reason}`;

/**
 * Real Gemini native acceptance for `googleSearch` (#225 slice 3). It pins
 * the high-risk combined declaration with a function tool, then verifies the
 * provider returns the query audit floor. Citation chunks remain optional.
 */
liveTest(`gemini built-in web search with function declarations [${label}]`, async () => {
  const config = resolved.config!;
  const adapter = createProvider(config);
  expect(adapter.id).toBe("gemini-generate-content");
  if (!adapter.stream) throw new Error("gemini adapter does not expose stream()");

  const request: VesicleRequest = {
    id: `acceptance-${crypto.randomUUID()}`,
    model: { provider: config.providerId, model: config.model },
    system: ["Use Google Search to answer the user. Do not call functions unless strictly necessary."],
    messages: [{ role: "user", content: "Search the web for today's date in UTC, then answer in one short sentence with the source." }],
    tools: [{
      type: "function",
      function: {
        name: "not_needed",
        description: "A test-only function that should not be needed for web search.",
        parameters: { type: "object", properties: {} },
      },
    }],
    webSearch: true,
    generation: { maxTokens: 512 },
  };

  const body = toGeminiGenerateContentBody(request);
  expect(body.tools).toEqual([
    {
      functionDeclarations: [{
        name: "not_needed",
        description: "A test-only function that should not be needed for web search.",
        parameters: { type: "object", properties: {} },
      }],
    },
    { googleSearch: {} },
  ]);

  const events: ProviderStreamEvent[] = [];
  for await (const event of adapter.stream(request)) events.push(event);
  const complete = [...events].reverse().find((event) => event.type === "complete");
  if (complete?.type !== "complete") throw new Error("gemini stream ended without a complete event");
  const report = complete.response.webSearch;
  if (!report) throw new Error("Gemini built-in web search did not produce a webSearch report.");
  expect(report.queries.length).toBeGreaterThan(0);
  expect(report.calls).toBeUndefined();
  for (const citation of report.citations ?? []) {
    expect(citation.url).toMatch(/^https?:\/\//);
    expect(citation.title.length).toBeGreaterThan(0);
  }
  summarize("gemini-builtin-web-search", {
    provider: config.providerId,
    model: config.model,
    queries: report.queries,
    citationCount: report.citations?.length ?? 0,
    streamEvents: events.length,
    finishReason: complete.response.finishReason ?? null,
  });
}, 180_000);
