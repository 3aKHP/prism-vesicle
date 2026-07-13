import { ProviderError } from "../shared/errors";
import type { ProviderThinkingBlock, ReasoningTier, VesicleRequest } from "../shared/types";
import type { AnthropicContentBlock, AnthropicMessage } from "./types";

const defaultMaxTokens = 4096;

export function toAnthropicMessagesBody(request: VesicleRequest): Record<string, unknown> {
  const hasTools = Boolean(request.tools && request.tools.length > 0);
  const maxTokens = request.generation?.maxTokens ?? defaultMaxTokens;
  return {
    model: request.model.model,
    system: request.system.join("\n\n"),
    messages: toAnthropicMessages(request.messages),
    max_tokens: maxTokens,
    temperature: request.generation?.temperature,
    thinking: anthropicThinkingControl(request.generation?.reasoningTier, maxTokens),
    tools: hasTools ? request.tools?.map((tool) => ({
      name: tool.function.name,
      description: tool.function.description,
      input_schema: tool.function.parameters,
    })) : undefined,
    tool_choice: hasTools ? { type: "auto" } : undefined,
  };
}

function toAnthropicMessages(messages: VesicleRequest["messages"]): AnthropicMessage[] {
  const serialized: AnthropicMessage[] = [];
  let pendingToolResults: AnthropicContentBlock[] = [];

  const flushToolResults = (): AnthropicMessage | undefined => {
    if (pendingToolResults.length === 0) return undefined;
    const message: AnthropicMessage = { role: "user", content: pendingToolResults };
    serialized.push(message);
    pendingToolResults = [];
    return message;
  };

  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "tool") {
      pendingToolResults.push({
        type: "tool_result",
        tool_use_id: message.toolCallId ?? "",
        content: message.images?.length
          ? anthropicUserBlocks(message.content, message.images)
          : message.content,
      });
      continue;
    }

    const flushedToolResults = flushToolResults();
    if (message.role === "assistant") {
      serialized.push(anthropicAssistantMessage(message));
      continue;
    }

    if (appendUserMessageToToolResults(flushedToolResults, message)) continue;
    serialized.push({
      role: "user",
      content: message.images?.length ? anthropicUserBlocks(message.content, message.images) : message.content,
    });
  }

  flushToolResults();
  return serialized;
}

function anthropicAssistantMessage(message: VesicleRequest["messages"][number]): AnthropicMessage {
  const content: AnthropicContentBlock[] = [
    ...anthropicThinkingBlocks(message.thinkingBlocks),
    ...(message.content ? [{ type: "text" as const, text: message.content }] : []),
    ...(message.toolCalls ?? []).map((call) => ({
      type: "tool_use" as const,
      id: call.id,
      name: call.name,
      input: parseToolArguments(call.arguments),
    })),
  ];
  return {
    role: "assistant",
    content: content.length > 0 ? content : [{ type: "text", text: "" }],
  };
}

function appendUserMessageToToolResults(
  toolResultMessage: AnthropicMessage | undefined,
  message: VesicleRequest["messages"][number],
): boolean {
  if (!toolResultMessage || !Array.isArray(toolResultMessage.content)) return false;
  if (message.images?.length) {
    toolResultMessage.content.push(...anthropicUserBlocks(message.content, message.images));
  } else if (message.content) {
    toolResultMessage.content.push({ type: "text", text: message.content });
  }
  return true;
}

function anthropicUserBlocks(
  text: string,
  images: NonNullable<VesicleRequest["messages"][number]["images"]>,
): AnthropicContentBlock[] {
  return [
    ...(text ? [{ type: "text" as const, text }] : []),
    ...images.flatMap((image, index) => [
      { type: "text" as const, text: `[Image #${index + 1}: ${image.sourcePath ?? image.filename ?? image.source}]` },
      {
        type: "image" as const,
        source: {
          type: "base64" as const,
          media_type: image.mediaType,
          data: requireImageData(image.data, image.id),
        },
      },
    ]),
  ];
}

function anthropicThinkingBlocks(blocks: ProviderThinkingBlock[] | undefined): AnthropicContentBlock[] {
  const result: AnthropicContentBlock[] = [];
  for (const block of blocks ?? []) {
    if (block.type === "thinking" && typeof block.thinking === "string") {
      result.push({
        type: "thinking",
        thinking: block.thinking,
        ...(typeof block.signature === "string" ? { signature: block.signature } : {}),
      });
    }
    if (block.type === "redacted_thinking" && typeof block.data === "string") {
      result.push({ type: "redacted_thinking", data: block.data });
    }
  }
  return result;
}

function requireImageData(data: string | undefined, id: string): string {
  if (!data) throw new Error(`Image attachment was not materialized before provider serialization: ${id}.`);
  return data;
}

function anthropicThinkingControl(tier: ReasoningTier | undefined, maxTokens: number): Record<string, unknown> | undefined {
  if (!tier) return undefined;
  if (tier === "off") return { type: "disabled" };
  if (maxTokens <= 1024) {
    throw new ProviderError("Anthropic thinking requires maxTokens greater than 1024.", { kind: "malformed_response" });
  }
  return { type: "enabled", budget_tokens: Math.min(thinkingBudgetForTier(tier), maxTokens - 1024) };
}

function thinkingBudgetForTier(tier: Exclude<ReasoningTier, "off">): number {
  switch (tier) {
    case "low":
      return 1024;
    case "medium":
      return 2048;
    case "high":
      return 4096;
    case "xhigh":
      return 8192;
    case "max":
      return 16000;
  }
}

function parseToolArguments(value: string): unknown {
  try {
    return JSON.parse(value || "{}");
  } catch {
    throw new ProviderError("Cannot serialize malformed tool-call arguments for Anthropic Messages.", {
      kind: "malformed_response",
    });
  }
}
