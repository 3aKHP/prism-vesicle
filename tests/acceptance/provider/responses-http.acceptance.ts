import { expect, test } from "bun:test";
import { loadConfigForSelection } from "../../../src/config/providers";
import { OpenAIResponsesAdapter } from "../../../src/providers/openai-responses/adapter";
import type { ProviderStreamEvent, VesicleRequest } from "../../../src/providers/shared/types";
import type { ProviderStateJson } from "../../../src/providers/shared/state";
import { summarize } from "./support";

const enabled = process.env.BUN_E2E_RESPONSES_PROVIDER !== undefined;
const providerId = process.env.BUN_E2E_RESPONSES_PROVIDER ?? "";
const model = process.env.BUN_E2E_RESPONSES_MODEL;

test.skipIf(!enabled)("real Responses HTTP/SSE function loop and native Item replay", async () => {
  const selected = await loadConfigForSelection({ provider: providerId, ...(model ? { model } : {}) });
  const adapter = new OpenAIResponsesAdapter({
    ...selected,
    provider: "openai-responses",
    responsesProfile: "codex-http-relay",
  });
  const initial: VesicleRequest = {
    id: `acceptance-${crypto.randomUUID()}`,
    model: { provider: selected.providerId, model: selected.model },
    system: ["Protocol acceptance: call echo_once exactly once, then answer briefly after its result."],
    messages: [{ role: "user", content: "Call echo_once with value ok." }],
    tools: [{ type: "function", function: {
      name: "echo_once",
      description: "Return the supplied value",
      parameters: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
    } }],
    generation: { maxTokens: 256 },
  };
  const firstEvents = await collect(adapter.stream!(initial));
  const first = completed(firstEvents);
  expect(first.toolCalls).toHaveLength(1);
  expect(nativeItemCount(first.providerState?.payload)).toBeGreaterThan(0);
  const call = first.toolCalls![0];

  const secondEvents = await collect(adapter.stream!({
    ...initial,
    id: `acceptance-${crypto.randomUUID()}`,
    messages: [
      ...initial.messages,
      { role: "assistant", content: first.content, toolCalls: first.toolCalls, providerState: first.providerState },
      { role: "tool", toolCallId: call.id, content: JSON.stringify({ value: "ok" }) },
    ],
  }));
  const second = completed(secondEvents);
  expect(second.content.length).toBeGreaterThan(0);
  expect(second.toolCalls ?? []).toHaveLength(0);
  summarize("responses-http", {
    provider: selected.providerId,
    model: selected.model,
    firstEventTypes: firstEvents.map((event) => event.type),
    callCount: first.toolCalls?.length ?? 0,
    callIdShape: call.id.startsWith("call_"),
    nativeItemCount: nativeItemCount(first.providerState?.payload),
    secondEventTypes: secondEvents.map((event) => event.type),
    finalContentLength: second.content.length,
    usagePresent: second.usage?.totalTokens !== undefined,
  });
}, 60_000);

async function collect(iterable: AsyncIterable<ProviderStreamEvent>): Promise<ProviderStreamEvent[]> {
  const events: ProviderStreamEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

function nativeItemCount(payload: ProviderStateJson | undefined): number {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return 0;
  return Array.isArray(payload.outputItems) ? payload.outputItems.length : 0;
}

function completed(events: ProviderStreamEvent[]) {
  const event = [...events].reverse().find((candidate) => candidate.type === "complete");
  if (!event || event.type !== "complete") throw new Error("Responses acceptance did not produce a completed response.");
  return event.response;
}
