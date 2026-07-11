import type { ReasoningTier, VesicleRequest } from "../shared/types";
import { reasoningContentFromThinkingBlocks } from "../shared/thinking";

export function toChatCompletionBody(request: VesicleRequest, stream: boolean, includeUsage = false): Record<string, unknown> {
  const hasTools = Boolean(request.tools && request.tools.length > 0);
  return {
    model: request.model.model,
    messages: [
      ...request.system.map((content) => ({ role: "system", content })),
      ...serializeOpenAIMessages(request.messages),
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

function serializeOpenAIMessages(messages: VesicleRequest["messages"]): Record<string, unknown>[] {
  const serialized: Record<string, unknown>[] = [];
  let pendingToolImages: NonNullable<VesicleRequest["messages"][number]["images"]> = [];
  const flushToolImages = () => {
    if (pendingToolImages.length === 0) return;
    serialized.push({ role: "user", content: openAIUserContent("", pendingToolImages) });
    pendingToolImages = [];
  };

  for (const message of messages) {
    if (message.role === "tool") {
      const toolMessage = {
        role: "tool",
        tool_call_id: message.toolCallId,
        content: message.content,
      };
      serialized.push(toolMessage);
      pendingToolImages.push(...(message.images ?? []));
      continue;
    }

    flushToolImages();

    if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
      const reasoningContent = assistantReasoningContent(message);
      serialized.push({
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
      });
      continue;
    }

    const body: Record<string, unknown> = {
      role: message.role,
      content: message.role === "user" && message.images?.length
        ? openAIUserContent(message.content, message.images)
        : message.content,
    };
    if (message.role === "assistant") {
      const reasoningContent = assistantReasoningContent(message);
      if (reasoningContent) body.reasoning_content = reasoningContent;
    }
    serialized.push(body);
  }
  flushToolImages();
  return serialized;
}

function openAIUserContent(
  text: string,
  images: NonNullable<VesicleRequest["messages"][number]["images"]>,
): Array<Record<string, unknown>> {
  return [
    ...(text ? [{ type: "text", text }] : []),
    ...images.flatMap((image, index) => [
      { type: "text", text: imageLabel(image, index) },
      {
        type: "image_url",
        image_url: {
          url: `data:${image.mediaType};base64,${requireImageData(image.data, image.id)}`,
          ...(image.detail ? { detail: image.detail === "original" ? "high" : image.detail } : {}),
        },
      },
    ]),
  ];
}

function imageLabel(image: NonNullable<VesicleRequest["messages"][number]["images"]>[number], index: number): string {
  const source = image.sourcePath ?? image.filename ?? image.source;
  return `[Image #${index + 1}: ${source}]`;
}

function requireImageData(data: string | undefined, id: string): string {
  if (!data) throw new Error(`Image attachment was not materialized before provider serialization: ${id}.`);
  return data;
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
