import { loadConfigForSelection } from "../../../src/config/providers";
import type { ResponsesProfile, VesicleConfig } from "../../../src/config/env";
import type { ProviderStreamEvent, VesicleRequest, VesicleResponse } from "../../../src/providers/shared/types";
import type { ProviderStateJson } from "../../../src/providers/shared/state";

export type ResponsesAcceptancePrecondition = {
  config?: VesicleConfig;
  reason: string;
};

export async function resolveResponsesAcceptance(options: {
  providerEnv: string;
  modelEnv: string;
  profile: ResponsesProfile;
  requireOfficialEndpoint?: boolean;
  requireRemoteCompact?: boolean;
  allowConfiguredProtocolOverride?: boolean;
}): Promise<ResponsesAcceptancePrecondition> {
  const providerId = process.env[options.providerEnv];
  if (!providerId) return { reason: `${options.providerEnv} is not set` };
  try {
    const model = process.env[options.modelEnv];
    const config = await loadConfigForSelection({ provider: providerId, ...(model ? { model } : {}) });
    if (!config.apiKey) return { reason: `${config.apiKeyLabel ?? "provider API key"} is missing` };
    if (!options.allowConfiguredProtocolOverride && config.provider !== "openai-responses") {
      return { reason: `${providerId} is not configured with protocol openai-responses` };
    }
    if (!options.allowConfiguredProtocolOverride && config.responsesProfile !== options.profile) {
      return { reason: `${providerId} uses responsesProfile ${config.responsesProfile ?? "missing"}, expected ${options.profile}` };
    }
    if (options.requireOfficialEndpoint && new URL(config.baseUrl).hostname !== "api.openai.com") {
      return { reason: `${providerId} is not the official api.openai.com endpoint` };
    }
    if (options.requireRemoteCompact && config.capabilities?.remoteCompact !== true) {
      return { reason: `${providerId}/${config.model} does not explicitly enable remoteCompact` };
    }
    return { config, reason: "ok" };
  } catch (error) {
    return { reason: error instanceof Error ? error.message : String(error) };
  }
}

export async function runResponsesFunctionLoop(
  adapter: { stream(request: VesicleRequest): AsyncIterable<ProviderStreamEvent> },
  config: VesicleConfig,
): Promise<{
  firstEvents: ProviderStreamEvent[];
  secondEvents: ProviderStreamEvent[];
  first: VesicleResponse;
  second: VesicleResponse;
  callId: string;
}> {
  const initial: VesicleRequest = {
    id: `acceptance-${crypto.randomUUID()}`,
    model: { provider: config.providerId, model: config.model },
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
  const firstEvents = await collect(adapter.stream(initial));
  const first = completed(firstEvents);
  if (first.toolCalls?.length !== 1) throw new Error(`Expected one function call, received ${first.toolCalls?.length ?? 0}.`);
  const call = first.toolCalls[0]!;
  const secondEvents = await collect(adapter.stream({
    ...initial,
    id: `acceptance-${crypto.randomUUID()}`,
    messages: [
      ...initial.messages,
      { role: "assistant", content: first.content, toolCalls: first.toolCalls, providerState: first.providerState },
      { role: "tool", toolCallId: call.id, content: JSON.stringify({ value: "ok" }) },
    ],
  }));
  const second = completed(secondEvents);
  return { firstEvents, secondEvents, first, second, callId: call.id };
}

export async function collect(iterable: AsyncIterable<ProviderStreamEvent>): Promise<ProviderStreamEvent[]> {
  const events: ProviderStreamEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

export function completed(events: ProviderStreamEvent[]): VesicleResponse {
  const event = [...events].reverse().find((candidate) => candidate.type === "complete");
  if (!event || event.type !== "complete") throw new Error("Responses acceptance did not produce a completed response.");
  return event.response;
}

export function nativeItemCount(payload: ProviderStateJson | undefined): number {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return 0;
  return Array.isArray(payload.outputItems) ? payload.outputItems.length : 0;
}
