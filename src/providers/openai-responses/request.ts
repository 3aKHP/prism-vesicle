import type { ToolDefinition } from "../../core/tools";
import type { ResponsesProfile } from "../../config/env";
import { ProviderError } from "../shared/errors";
import { parseProviderStateEnvelope, type ProviderStateEnvelope, type ProviderStateJson } from "../shared/state";
import { PROVIDER_NATIVE_CHECKPOINT_KIND, type ProviderCompactRequest, type ReasoningTier, type VesicleMessage, type VesicleRequest } from "../shared/types";
import { validateResponsesCompactItems, validateResponsesOutputItems } from "./items";
import { openAIResponsesProtocol, type ResponsesOutputItem } from "./types";

type RequestContext = { providerId: string; endpointFingerprint: string; profile?: ResponsesProfile };
export type ResponsesContinuation = { responseId: string; afterMessageIndex: number; pendingCallIds: string[] };

export function toResponsesBody(
  request: VesicleRequest,
  context: RequestContext,
  stream: boolean,
  profile: ResponsesProfile,
): Record<string, unknown> {
  const tools = request.tools?.map(toResponsesTool);
  if (isStatelessHttpSubset(profile)) {
    return {
      model: request.model.model,
      instructions: request.system.join("\n\n") || undefined,
      input: serializeResponsesInput(request.messages, request.model.model, { ...context, profile }),
      tools: tools?.length ? tools : undefined,
      tool_choice: tools?.length ? "auto" : undefined,
      reasoning: reasoningControl(request.generation?.reasoningTier, false, context.providerId, profile),
      stream,
      max_output_tokens: request.generation?.maxTokens,
      temperature: request.generation?.temperature,
      text: { verbosity: "medium" },
    };
  }
  return {
    model: request.model.model,
    instructions: request.system.join("\n\n") || undefined,
    input: serializeResponsesInput(request.messages, request.model.model, { ...context, profile }),
    tools: tools?.length ? tools : undefined,
    tool_choice: tools?.length ? "auto" : undefined,
    parallel_tool_calls: true,
    reasoning: reasoningControl(request.generation?.reasoningTier, true, context.providerId),
    store: false,
    stream,
    stream_options: stream ? { include_obfuscation: false } : undefined,
    include: ["reasoning.encrypted_content"],
    service_tier: profile === "codex-http-relay" ? undefined : "auto",
    prompt_cache_key: request.id,
    temperature: request.generation?.temperature,
    text: { verbosity: "medium" },
    max_output_tokens: request.generation?.maxTokens,
  };
}

export function toResponsesCompactBody(request: ProviderCompactRequest, context: RequestContext): Record<string, unknown> {
  return {
    model: request.model.model,
    input: serializeResponsesInput(request.messages, request.model.model, context),
  };
}

export function toResponsesWebSocketMessage(
  request: VesicleRequest,
  context: RequestContext,
  continuation?: ResponsesContinuation,
  generate = true,
  profile: "openai-public" | "codex-beta-2026-02-06" = "openai-public",
): Record<string, unknown> {
  const base = toResponsesBody(request, context, false, profile);
  const tools = base.tools;
  const input = continuation
    ? serializeResponsesInput(
        request.messages.slice(continuation.afterMessageIndex),
        request.model.model,
        context,
        continuation.pendingCallIds,
      )
    : base.input;
  return {
    type: "response.create",
    model: base.model,
    instructions: base.instructions,
    previous_response_id: continuation?.responseId,
    input,
    tools,
    tool_choice: base.tool_choice,
    parallel_tool_calls: base.parallel_tool_calls,
    reasoning: base.reasoning,
    store: base.store,
    stream: profile === "codex-beta-2026-02-06" ? true : undefined,
    stream_options: profile === "codex-beta-2026-02-06" ? { include_obfuscation: false } : undefined,
    include: base.include,
    service_tier: base.service_tier,
    prompt_cache_key: base.prompt_cache_key,
    temperature: base.temperature,
    text: base.text,
    max_output_tokens: base.max_output_tokens,
    generate: generate ? undefined : false,
  };
}

export function findResponsesContinuation(
  request: VesicleRequest,
  context: RequestContext,
  expectedResponseId: string | undefined,
): ResponsesContinuation | undefined {
  if (!expectedResponseId) return undefined;
  for (let index = request.messages.length - 1; index >= 0; index--) {
    const message = request.messages[index];
    if (message.kind === PROVIDER_NATIVE_CHECKPOINT_KIND) return undefined;
    if (message.role !== "assistant" || !message.providerState) continue;
    const native = nativeOutputItems(message.providerState, request.model.model, context);
    // The newest native assistant state owns the continuation frontier. An
    // owner mismatch must not jump backward across a provider/model switch.
    if (!native) return undefined;
    const payload = message.providerState.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload) || payload.responseId !== expectedResponseId) return undefined;
    return {
      responseId: expectedResponseId,
      afterMessageIndex: index + 1,
      pendingCallIds: native.flatMap((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item) || item.type !== "function_call") return [];
        return typeof item.call_id === "string" ? [item.call_id] : [];
      }),
    };
  }
  return undefined;
}

export function usesResponsesNativeCheckpoint(request: VesicleRequest, context: RequestContext): boolean {
  return request.messages.some((message) =>
    message.kind === PROVIDER_NATIVE_CHECKPOINT_KIND
    && nativeCompactInput(message.providerState, request.model.model, context) !== undefined);
}

function serializeResponsesInput(
  messages: VesicleMessage[],
  model: string,
  context: RequestContext,
  initialCallIds: readonly string[] = [],
): unknown[] {
  const input: unknown[] = [];
  const declaredCallIds = new Set(initialCallIds);
  const answeredCallIds = new Set<string>();
  for (const message of messages) {
    if (message.kind === PROVIDER_NATIVE_CHECKPOINT_KIND) {
      const compacted = nativeCompactInput(message.providerState, model, context);
      if (compacted) {
        input.length = 0;
        declaredCallIds.clear();
        answeredCallIds.clear();
        for (const item of compacted) {
          if (item.type === "function_call" && typeof item.call_id === "string") declaredCallIds.add(item.call_id);
          if (item.type === "function_call_output" && typeof item.call_id === "string") answeredCallIds.add(item.call_id);
        }
        input.push(...compacted);
      }
      continue;
    }
    if (message.role === "assistant" && message.providerState) {
      const native = nativeOutputItems(message.providerState, model, context);
      if (native) {
        for (const item of native) {
          if (!item || typeof item !== "object" || Array.isArray(item) || item.type !== "function_call") continue;
          declareCallId(item.call_id, declaredCallIds);
        }
        input.push(...native);
        continue;
      }
    }
    if (message.role === "tool") {
      if (!message.toolCallId) throw new Error("OpenAI Responses tool output is missing its call_id.");
      if (!declaredCallIds.has(message.toolCallId)) throw new Error(`OpenAI Responses function output has no preceding call_id ${message.toolCallId}.`);
      if (answeredCallIds.has(message.toolCallId)) throw new Error(`OpenAI Responses call_id ${message.toolCallId} was answered more than once.`);
      answeredCallIds.add(message.toolCallId);
      input.push({ type: "function_call_output", call_id: message.toolCallId, output: message.content });
      continue;
    }
    if (message.role === "assistant" && message.toolCalls?.length) {
      if (message.content) input.push({ role: "assistant", content: message.content });
      input.push(...message.toolCalls.map((call) => {
        declareCallId(call.id, declaredCallIds);
        return { type: "function_call", call_id: call.id, name: call.name, arguments: call.arguments };
      }));
      continue;
    }
    input.push({
      role: message.role,
      content: message.images?.length && message.role === "user"
        ? userContent(message)
        : message.content,
    });
  }
  const unanswered = [...declaredCallIds].find((callId) => !answeredCallIds.has(callId));
  if (unanswered) throw new Error(`OpenAI Responses function call_id ${unanswered} has no result.`);
  return input;
}

function nativeCompactInput(state: VesicleMessage["providerState"], model: string, context: RequestContext): ResponsesOutputItem[] | undefined {
  if (!state) return undefined;
  let envelope: ProviderStateEnvelope;
  try {
    envelope = parseProviderStateEnvelope(state);
  } catch {
    return undefined;
  }
  if (envelope.protocol !== openAIResponsesProtocol
    || envelope.providerId !== context.providerId
    || envelope.model !== model
    || envelope.endpointFingerprint !== context.endpointFingerprint) return undefined;
  const payload = envelope.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)
    || payload.version !== 1 || payload.profile !== (context.profile ?? "openai-public")
    || !Array.isArray(payload.compactedInput)) return undefined;
  try {
    return validateResponsesCompactItems(payload.compactedInput as ResponsesOutputItem[], context.providerId);
  } catch {
    // Native compaction is optional. A corrupted provider-owned projection
    // selects the portable summary instead of making the session unreadable.
    return undefined;
  }
}

function declareCallId(value: ProviderStateJson | string, declared: Set<string>): void {
  if (typeof value !== "string" || !value) throw new Error("OpenAI Responses function call is missing its call_id.");
  if (declared.has(value)) throw new Error(`OpenAI Responses function call_id ${value} was declared more than once.`);
  declared.add(value);
}

function nativeOutputItems(state: VesicleMessage["providerState"], model: string, context: RequestContext): ProviderStateJson[] | undefined {
  try {
    const envelope = parseProviderStateEnvelope(state);
    if (envelope.protocol !== openAIResponsesProtocol
      || envelope.providerId !== context.providerId
      || envelope.model !== model
      || envelope.endpointFingerprint !== context.endpointFingerprint) return undefined;
    const payload = envelope.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload) || payload.version !== 1
      || payload.profile !== (context.profile ?? "openai-public") || !Array.isArray(payload.outputItems)) return undefined;
    return validateResponsesOutputItems(
      payload.outputItems as ResponsesOutputItem[],
      context.providerId,
      context.profile,
    ) as ProviderStateJson[];
  } catch {
    // Provider-native replay is optional. Corrupt or rejected state selects
    // portable assistant history instead of making the session unreadable.
    return undefined;
  }
}

function toResponsesTool(tool: ToolDefinition): Record<string, unknown> {
  return {
    type: "function",
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
  };
}

function reasoningControl(
  tier: ReasoningTier | undefined,
  summary: boolean,
  providerId: string,
  profile?: ResponsesProfile,
): Record<string, unknown> | undefined {
  if (!tier) return undefined;
  if (tier === "off") return { effort: "none" };
  if (profile === "deepseek-subset-2026-07-31") {
    switch (tier) {
      case "low": return { effort: "low" };
      case "medium":
      case "high":
      case "xhigh": return { effort: "high" };
      case "max": return { effort: "max" };
      default:
        throw new ProviderError(`Unsupported reasoning tier: ${String(tier)}.`, {
          kind: "malformed_response", providerId,
        });
    }
  }
  let effort: "low" | "medium" | "high" | "xhigh";
  switch (tier) {
    case "low":
    case "medium":
    case "high":
      effort = tier;
      break;
    case "xhigh":
      effort = summary ? "xhigh" : "high";
      break;
    case "max":
      effort = summary ? "xhigh" : "high";
      break;
    default:
      throw new ProviderError(`Unsupported reasoning tier: ${String(tier)}.`, {
        kind: "malformed_response", providerId,
      });
  }
  return { effort, ...(summary ? { summary: "auto" } : {}) };
}

function isStatelessHttpSubset(profile: ResponsesProfile): boolean {
  return profile === "mimo-subset-2026-07-30"
    || profile === "deepseek-subset-2026-07-31";
}

function userContent(message: VesicleMessage): Array<Record<string, unknown>> {
  return [
    ...(message.content ? [{ type: "input_text", text: message.content }] : []),
    ...(message.images ?? []).map((image) => ({
      type: "input_image",
      image_url: `data:${image.mediaType};base64,${requireImageData(image.data, image.id)}`,
      ...(image.detail ? { detail: image.detail === "original" ? "high" : image.detail } : {}),
    })),
  ];
}

function requireImageData(data: string | undefined, id: string): string {
  if (!data) throw new Error(`Image attachment was not materialized before provider serialization: ${id}.`);
  return data;
}
