// `/btw` side-question contracts. A side question is one tool-free provider
// response over a frozen copy of the current conversation context. The
// snapshot is the provider-valid context boundary the side service replays; it
// must never share mutable identity with the live agent-loop message array and
// must never retain materialized image bytes.

import type { ProviderSelection } from "../../config/providers";
import type { EngineId } from "../engine/profile";
import type { VesicleImageAttachment, VesicleMessage, VesicleRequest } from "../../providers/shared/types";

export type SideQuestionContextSnapshot = {
  sessionId: string;
  engine: EngineId;
  providerSelection: ProviderSelection;
  generation?: VesicleRequest["generation"];
  visionEnabled: boolean;
  /**
   * The parent Engine's system prompt (incl. frozen Stage bootstrap context).
   * Reference data only: it is quoted inside the side request's user packet,
   * never serialized as a side system message.
   */
  engineSystemPrompt: string;
  messages: VesicleMessage[];
};

/**
 * Clone the message array and its nested tool-call / thinking blocks for an
 * immutable side snapshot. Image attachments are kept as content-addressed
 * references only; base64 `data` is dropped so the snapshot never holds
 * materialized image bytes. The side service materializes images for the side
 * provider request only when the snapshot declares vision support.
 */
export function cloneSideQuestionMessages(messages: VesicleMessage[]): VesicleMessage[] {
  return messages.map((message) => ({
    role: message.role,
    content: message.content,
    ...(message.kind ? { kind: message.kind } : {}),
    ...(message.reasoningContent ? { reasoningContent: message.reasoningContent } : {}),
    ...(message.thinkingBlocks
      ? { thinkingBlocks: message.thinkingBlocks.map((block) => ({ ...block })) }
      : {}),
    ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
    ...(message.toolCalls ? { toolCalls: message.toolCalls.map((call) => ({ ...call })) } : {}),
    ...(message.images ? { images: message.images.map(stripImageBytes) } : {}),
  }));
}

function stripImageBytes(image: VesicleImageAttachment): VesicleImageAttachment {
  const { data: _data, ...reference } = image;
  return reference;
}
