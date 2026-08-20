import { expect, test } from "bun:test";
import { OpenAIResponsesAdapter } from "../../../src/providers/openai-responses/adapter";
import type { ProviderStreamEvent, VesicleRequest, VesicleResponse } from "../../../src/providers/shared/types";
import { summarize } from "./support";
import { collect, completed, resolveResponsesAcceptance } from "./responses-support";

// Opt-in acceptance lanes for provider-side built-in web search (#225 slice 2).
// The DeepSeek lane deliberately does not require the official endpoint: the
// primary real-world target is a self-hosted relay gateway speaking the same
// Responses subset, mirroring how the capability was verified upstream.
const deepseek = await resolveResponsesAcceptance({
  providerEnv: "BUN_E2E_DEEPSEEK_RESPONSES_PROVIDER",
  modelEnv: "BUN_E2E_DEEPSEEK_RESPONSES_MODEL",
  profile: "deepseek-subset-2026-08-19",
});
if (!deepseek.config) console.log(`[acceptance:builtin-web-search:deepseek] unavailable: ${deepseek.reason}`);
const deepseekTest: typeof test = deepseek.config ? test : test.skip;

const openai = await resolveResponsesAcceptance({
  providerEnv: "BUN_E2E_OPENAI_RESPONSES_PROVIDER",
  modelEnv: "BUN_E2E_OPENAI_RESPONSES_MODEL",
  profile: "openai-public",
  requireOfficialEndpoint: true,
  requireRemoteCompact: true,
});
if (!openai.config) console.log(`[acceptance:builtin-web-search:openai] unavailable: ${openai.reason}`);
const openaiTest: typeof test = openai.config ? test : test.skip;

function searchRequest(providerId: string, model: string): VesicleRequest {
  return {
    id: `acceptance-${crypto.randomUUID()}`,
    model: { provider: providerId, model },
    system: ["Answer briefly and cite the web sources you used."],
    messages: [{ role: "user", content: "Search the web for today's date in UTC, then state it in one line with the source you relied on." }],
    webSearch: true,
    generation: { maxTokens: 512 },
  };
}

async function runSearchTurn(
  adapter: OpenAIResponsesAdapter,
  request: VesicleRequest,
): Promise<{ first: VesicleResponse; second: VesicleResponse; firstEvents: ProviderStreamEvent[]; secondEvents: ProviderStreamEvent[] }> {
  const firstEvents = await collect(adapter.stream(request));
  const first = completed(firstEvents);
  if (!first.webSearch) throw new Error("Built-in web search acceptance did not produce a webSearch report.");
  const secondEvents = await collect(adapter.stream({
    ...request,
    id: `acceptance-${crypto.randomUUID()}`,
    messages: [
      ...request.messages,
      {
        role: "assistant",
        content: first.content,
        ...(first.webSearch ? { webSearch: first.webSearch } : {}),
        ...(first.providerState ? { providerState: first.providerState } : {}),
      },
      { role: "user", content: "In one word: was the previous answer grounded in a web source?" },
    ],
  }));
  const second = completed(secondEvents);
  return { first, second, firstEvents, secondEvents };
}

deepseekTest("real DeepSeek dated subset executes built-in search and replays its calls", async () => {
  const config = deepseek.config!;
  const adapter = new OpenAIResponsesAdapter({ ...config, responsesTransport: "http" });
  const { first, second, firstEvents, secondEvents } = await runSearchTurn(adapter, searchRequest(config.providerId, config.model));
  const report = first.webSearch!;

  expect(report.queries.length).toBeGreaterThan(0);
  expect(report.calls?.length ?? 0).toBeGreaterThan(0);
  expect(second.content.length).toBeGreaterThan(0);
  expect(second.webSearch).toBeUndefined();
  summarize("builtin-web-search-deepseek", {
    provider: config.providerId,
    model: config.model,
    queries: report.queries,
    callCount: report.calls?.length ?? 0,
    firstEventTypes: firstEvents.map((event) => event.type),
    secondEventTypes: secondEvents.map((event) => event.type),
  });
}, 180_000);

openaiTest("official OpenAI public profile grounds answers with url_citation annotations", async () => {
  const config = openai.config!;
  const adapter = new OpenAIResponsesAdapter({ ...config, responsesTransport: "http" });
  const { first, second, firstEvents, secondEvents } = await runSearchTurn(adapter, searchRequest(config.providerId, config.model));
  const report = first.webSearch!;

  expect(report.queries.length).toBeGreaterThan(0);
  // url_citation annotations are optional model behavior; when present they
  // must carry the normalized url/title pair (shape is pinned by the
  // deterministic provider suite).
  for (const citation of report.citations ?? []) {
    expect(citation.url).toMatch(/^https?:\/\//);
    expect(citation.title.length).toBeGreaterThan(0);
  }
  expect(second.content.length).toBeGreaterThan(0);
  summarize("builtin-web-search-openai", {
    provider: config.providerId,
    model: config.model,
    queries: report.queries,
    citationCount: report.citations?.length ?? 0,
    firstEventTypes: firstEvents.map((event) => event.type),
    secondEventTypes: secondEvents.map((event) => event.type),
  });
}, 180_000);
