import type { VesicleRequest } from "../shared/types";

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
          return {
            role: "assistant",
            content: message.content || null,
            ...(message.reasoningContent ? { reasoning_content: message.reasoningContent } : {}),
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
        if (message.role === "assistant" && message.reasoningContent) {
          body.reasoning_content = message.reasoningContent;
        }
        return body;
      }),
    ],
    tools: hasTools ? request.tools : undefined,
    tool_choice: hasTools ? "auto" : undefined,
    temperature: request.generation?.temperature ?? 0.7,
    max_tokens: request.generation?.maxTokens,
    stream,
    stream_options: stream && includeUsage ? { include_usage: true } : undefined,
  };
}
