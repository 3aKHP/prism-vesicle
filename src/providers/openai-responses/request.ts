import type { ToolDefinition } from "../../core/tools";
import { parseProviderStateEnvelope, type ProviderStateJson } from "../shared/state";
import type { ReasoningTier, VesicleMessage, VesicleRequest } from "../shared/types";

export const openAIResponsesProtocol = "openai-responses";

type RequestContext = { providerId: string; endpointFingerprint: string };

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

function serializeResponsesInput(messages: VesicleMessage[], model: string, context: RequestContext): unknown[] {
  const input: unknown[] = [];
  const answeredCallIds = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant" && message.providerState) {
      const native = nativeOutputItems(message.providerState, model, context);
      if (native) {
        input.push(...native);
        continue;
      }
    }
    if (message.role === "tool") {
      if (!message.toolCallId) throw new Error("OpenAI Responses tool output is missing its call_id.");
      if (answeredCallIds.has(message.toolCallId)) throw new Error(`OpenAI Responses call_id ${message.toolCallId} was answered more than once.`);
      answeredCallIds.add(message.toolCallId);
      input.push({ type: "function_call_output", call_id: message.toolCallId, output: message.content });
      continue;
    }
    if (message.role === "assistant" && message.toolCalls?.length) {
      if (message.content) input.push({ role: "assistant", content: message.content });
      input.push(...message.toolCalls.map((call) => ({
        type: "function_call",
        call_id: call.id,
        name: call.name,
        arguments: call.arguments,
      })));
      continue;
    }
    input.push({
      role: message.role,
      content: message.images?.length && message.role === "user"
        ? userContent(message)
        : message.content,
    });
  }
  return input;
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
  return payload.outputItems;
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
