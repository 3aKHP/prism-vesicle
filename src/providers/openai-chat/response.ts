import { ProviderError } from "../shared/errors";
import { thinkingBlocksFromReasoningContent } from "../shared/thinking";
import type { VesicleResponse } from "../shared/types";
import type { ChatCompletionResponse } from "./types";

export function responseFromChatCompletionBody(
  body: ChatCompletionResponse | undefined,
  fallbackId: string,
  providerId?: string,
): VesicleResponse {
  const choice = body?.choices?.[0];
  const content = choice?.message?.content ?? "";
  const reasoningContent = choice?.message?.reasoning_content ?? undefined;
  const toolCalls = choice?.message?.tool_calls?.map((toolCall) => ({
    id: toolCall.id,
    name: toolCall.function.name,
    arguments: toolCall.function.arguments,
  }));

  if (!content && (!toolCalls || toolCalls.length === 0)) {
    throw new ProviderError("Provider response did not include assistant content or tool calls.", {
      kind: "malformed_response",
      providerId,
    });
  }

  return {
    id: body?.id ?? fallbackId,
    content,
    ...(reasoningContent ? { reasoningContent } : {}),
    ...(reasoningContent ? { thinkingBlocks: thinkingBlocksFromReasoningContent(reasoningContent) } : {}),
    toolCalls,
    finishReason: choice?.finish_reason ?? undefined,
    raw: body,
    usage: {
      inputTokens: body?.usage?.prompt_tokens,
      outputTokens: body?.usage?.completion_tokens,
      totalTokens: body?.usage?.total_tokens,
    },
  };
}

export async function readProviderErrorMessage(response: Response): Promise<string> {
  const body = await response.json().catch(() => undefined) as ChatCompletionResponse | undefined;
  return body?.error?.message ?? response.statusText;
}
