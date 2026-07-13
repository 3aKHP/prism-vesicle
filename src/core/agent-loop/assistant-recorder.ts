import type { VesicleMessage, VesicleResponse } from "../../providers/shared/types";
import type { EngineProfile } from "../engine/profile";
import type { SessionStore } from "../session/store";
import type { ToolCall } from "../tools";

export async function recordAssistantToolCalls(options: {
  response: VesicleResponse;
  toolCalls: ToolCall[];
  messages: VesicleMessage[];
  session: SessionStore;
  profile: EngineProfile;
  model: string;
}): Promise<VesicleMessage[]> {
  const { response, toolCalls } = options;
  const parentMessages = [...options.messages];
  options.messages.push({
    role: "assistant",
    content: response.content,
    ...(response.reasoningContent ? { reasoningContent: response.reasoningContent } : {}),
    ...(response.thinkingBlocks ? { thinkingBlocks: response.thinkingBlocks } : {}),
    toolCalls,
  });
  await options.session.append({
    role: "assistant",
    content: response.content,
    metadata: {
      engine: options.profile.id,
      model: options.model,
      providerResponseId: response.id,
      finishReason: response.finishReason,
      ...(response.reasoningContent ? { reasoningContent: response.reasoningContent } : {}),
      ...(response.thinkingBlocks ? { thinkingBlocks: response.thinkingBlocks } : {}),
      ...(response.usage ? { usage: response.usage } : {}),
      toolCalls,
    },
  });
  return parentMessages;
}
