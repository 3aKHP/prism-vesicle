import type { ToolDefinition } from "../../core/tools";
import { parseProviderStateEnvelope, type ProviderStateJson } from "../shared/state";
import type { ReasoningTier, VesicleMessage, VesicleRequest } from "../shared/types";
import { validateResponsesOutputItems } from "./items";
import { openAIResponsesProtocol, type ResponsesOutputItem } from "./types";

type RequestContext = { providerId: string; endpointFingerprint: string };
export type ResponsesContinuation = { responseId: string; afterMessageIndex: number; pendingCallIds: string[] };

export function toResponsesBody(request: VesicleRequest, context: RequestContext, stream: boolean): Record<string, unknown> {
  const tools = request.tools?.map(toResponsesTool);
  return {
    model: request.model.model,
    instructions: request.system.join("\n\n") || undefined,
    input: serializeResponsesInput(request.messages, request.model.model, context),
    tools: tools?.length ? tools : undefined,
    tool_choice: tools?.length ? "auto" : undefined,
    parallel_tool_calls: true,
    reasoning: reasoningControl(request.generation?.reasoningTier),
    store: false,
    stream,
    stream_options: stream ? { include_obfuscation: false } : undefined,
    include: ["reasoning.encrypted_content"],
    service_tier: "auto",
    prompt_cache_key: request.id,
    text: { verbosity: "medium" },
    max_output_tokens: request.generation?.maxTokens,
  };
}

export function toResponsesWebSocketMessage(
  request: VesicleRequest,
  context: RequestContext,
  continuation?: ResponsesContinuation,
  generate = true,
  profile: "openai-public" | "codex-beta-2026-02-06" = "openai-public",
): Record<string, unknown> {
  const base = toResponsesBody(request, context, false);
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
    if (message.role !== "assistant" || !message.providerState) continue;
    const native = nativeOutputItems(message.providerState, request.model.model, context);
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

function declareCallId(value: ProviderStateJson | string, declared: Set<string>): void {
  if (typeof value !== "string" || !value) throw new Error("OpenAI Responses function call is missing its call_id.");
  if (declared.has(value)) throw new Error(`OpenAI Responses function call_id ${value} was declared more than once.`);
  declared.add(value);
}

function nativeOutputItems(state: VesicleMessage["providerState"], model: string, context: RequestContext): ProviderStateJson[] | undefined {
  const envelope = parseProviderStateEnvelope(state);
  if (envelope.protocol !== openAIResponsesProtocol
    || envelope.providerId !== context.providerId
    || envelope.model !== model
    || envelope.endpointFingerprint !== context.endpointFingerprint) return undefined;
  const payload = envelope.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || payload.version !== 1 || !Array.isArray(payload.outputItems)) {
    throw new Error("OpenAI Responses native state is malformed.");
  }
  return validateResponsesOutputItems(payload.outputItems as ResponsesOutputItem[], context.providerId) as ProviderStateJson[];
}

function toResponsesTool(tool: ToolDefinition): Record<string, unknown> {
  return {
    type: "function",
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
  };
}

function reasoningControl(tier: ReasoningTier | undefined): Record<string, unknown> | undefined {
  if (!tier || tier === "off") return undefined;
  return { effort: tier === "max" ? "xhigh" : tier, summary: "auto" };
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
