import type { ReasoningTier, VesicleRequest } from "../shared/types";
import { reasoningContentFromThinkingBlocks } from "../shared/thinking";

export function toChatCompletionBody(request: VesicleRequest, stream: boolean, includeUsage = false): Record<string, unknown> {
  const hasTools = Boolean(request.tools && request.tools.length > 0);
  return {
    model: request.model.model,
    messages: [
      ...request.system.map((content) => ({ role: "system", content })),
      ...request.messages.map((message) => {
        if (message.role === "tool") {
          return {
            role: "tool",
            tool_call_id: message.toolCallId,
            content: message.content,
          };
        }

        if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
          const reasoningContent = assistantReasoningContent(message);
          return {
            role: "assistant",
            content: message.content || null,
            ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
            tool_calls: message.toolCalls.map((call) => ({
              id: call.id,
              type: "function",
              function: {
                name: call.name,
                arguments: call.arguments,
              },
            })),
          };
        }

        const body: Record<string, unknown> = {
          role: message.role,
          content: message.content,
        };
        if (message.role === "assistant") {
          const reasoningContent = assistantReasoningContent(message);
          if (reasoningContent) body.reasoning_content = reasoningContent;
        }
        return body;
      }),
    ],
    tools: hasTools ? request.tools : undefined,
    tool_choice: hasTools ? "auto" : undefined,
    temperature: request.generation?.temperature,
    max_tokens: request.generation?.maxTokens,
    ...reasoningControls(request.generation?.reasoningTier),
    stream,
    stream_options: stream && includeUsage ? { include_usage: true } : undefined,
  };
}

function assistantReasoningContent(message: VesicleRequest["messages"][number]): string | undefined {
  return reasoningContentFromThinkingBlocks(message.thinkingBlocks) ?? message.reasoningContent;
}

function reasoningControls(tier: ReasoningTier | undefined): Record<string, unknown> {
  if (!tier) return {};
  if (tier === "off") {
    return { thinking: { type: "disabled" } };
  }
  return {
    thinking: { type: "enabled" },
    reasoning_effort: tier === "xhigh" || tier === "max" ? "max" : "high",
  };
}
