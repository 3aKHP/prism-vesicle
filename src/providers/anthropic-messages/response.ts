import { ProviderError } from "../shared/errors";
import { displayTextFromThinkingBlocks } from "../shared/thinking";
import type { ProviderThinkingBlock, VesicleResponse } from "../shared/types";
import type { AnthropicResponse } from "./types";
import { usageFromAnthropicUsage } from "./usage";

export function responseFromAnthropicBody(
  body: AnthropicResponse | undefined,
  fallbackId: string,
  providerId?: string,
): VesicleResponse {
  const textParts: string[] = [];
  const thinkingBlocks: ProviderThinkingBlock[] = [];
  const toolCalls: NonNullable<VesicleResponse["toolCalls"]> = [];

  for (const block of body?.content ?? []) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text") {
      textParts.push(block.text);
      continue;
    }
    if (block.type === "thinking") {
      thinkingBlocks.push({
        type: "thinking",
        thinking: block.thinking,
        ...(typeof block.signature === "string" ? { signature: block.signature } : {}),
      });
      continue;
    }
    if (block.type === "redacted_thinking") {
      thinkingBlocks.push({ type: "redacted_thinking", data: block.data });
      continue;
    }
    if (block.type === "tool_use") toolCalls.push(toolCallFromBlock(block, providerId));
  }

  const content = textParts.join("");
  const reasoningContent = displayTextFromThinkingBlocks(thinkingBlocks);
  if (!content && toolCalls.length === 0) {
    throw new ProviderError("Provider response did not include assistant content or tool calls.", {
      kind: "malformed_response",
      providerId,
    });
  }

  return {
    id: body?.id ?? fallbackId,
    content,
    ...(reasoningContent ? { reasoningContent } : {}),
    ...(thinkingBlocks.length > 0 ? { thinkingBlocks } : {}),
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    finishReason: body?.stop_reason,
    raw: body,
    usage: usageFromAnthropicUsage(body?.usage),
  };
}

function toolCallFromBlock(
  block: Extract<NonNullable<AnthropicResponse["content"]>[number], { type: "tool_use" }>,
  providerId?: string,
): NonNullable<VesicleResponse["toolCalls"]>[number] {
  if (!block.id || !block.name) {
    throw new ProviderError("Provider response included a tool_use block without id or name.", {
      kind: "malformed_response",
      providerId,
    });
  }
  return {
    id: block.id,
    name: block.name,
    arguments: jsonString(block.input),
  };
}

function jsonString(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}
