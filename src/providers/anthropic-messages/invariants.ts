import { PROVIDER_NATIVE_CHECKPOINT_KIND, type VesicleMessage } from "../shared/types";

/** A tool call issued by an assistant turn that still awaits its tool result. */
type OutstandingToolCall = {
  assistantIndex: number;
  remaining: number;
};

/**
 * Validate host message history against the Anthropic Messages tool-use
 * contract before the history is replayed through `toAnthropicMessages`.
 *
 * The serializer is fail-open on tool-use pairing: it emits an empty
 * `tool_use_id` for tool results without `toolCallId`, and it neither requires
 * every assistant `tool_use` to be answered nor rejects results that answer
 * nothing — the Messages API rejects those shapes only after the request has
 * been sent. This check mirrors the serializer's batching rules exactly:
 * system records and provider-native checkpoint markers are invisible, tool
 * results accumulate until the next user/assistant turn, and tool-result
 * images and error flags only shape content, never pairing. Anything the
 * serializer legitimately accepts therefore passes here.
 *
 * Returns one human-readable violation per defect, each naming the message
 * index and tool call id involved; an empty array means the history is valid.
 */
export function validateAnthropicHistory(messages: VesicleMessage[]): string[] {
  const violations: string[] = [];
  const outstanding = new Map<string, OutstandingToolCall>();
  // The Messages API requires the first message on the wire to be role user.
  // Host-only system records and checkpoint markers are skipped by the
  // serializer, so the check applies to the first message it would emit.
  const firstVisible = messages.find((message) => message.kind !== PROVIDER_NATIVE_CHECKPOINT_KIND && message.role !== "system");
  if (firstVisible && firstVisible.role !== "user") {
    violations.push(`The first serialized message has role "${firstVisible.role}"; the Messages API requires the conversation to open with a user message.`);
  }

  const closeToolResultRun = (boundary: string): void => {
    for (const [id, call] of outstanding) {
      if (call.remaining > 0) {
        violations.push(`messages[${call.assistantIndex}] assistant tool call "${id}" is not answered by a tool result before ${boundary}.`);
      }
    }
    outstanding.clear();
  };

  for (const [index, message] of messages.entries()) {
    if (message.kind === PROVIDER_NATIVE_CHECKPOINT_KIND) continue;
    if (message.role === "system") continue;

    if (message.role === "tool") {
      if (!message.toolCallId) {
        violations.push(`messages[${index}] tool result has an empty toolCallId, which would serialize as tool_use_id "".`);
        continue;
      }
      const pending = outstanding.get(message.toolCallId);
      if (!pending) {
        violations.push(`messages[${index}] tool result "${message.toolCallId}" does not answer any pending tool call from the preceding assistant turn.`);
        continue;
      }
      if (pending.remaining === 0) {
        violations.push(`messages[${index}] tool result "${message.toolCallId}" answers a tool call that already received its tool result.`);
        continue;
      }
      pending.remaining -= 1;
      continue;
    }

    closeToolResultRun(`the next turn at messages[${index}]`);
    if (message.role === "assistant") {
      let callPosition = 0;
      for (const call of message.toolCalls ?? []) {
        callPosition += 1;
        if (!call.id) {
          violations.push(`messages[${index}] assistant tool call #${callPosition} ("${call.name}") has an empty id, which would serialize as a tool_use id "".`);
          continue;
        }
        const pending = outstanding.get(call.id);
        if (pending) pending.remaining += 1;
        else outstanding.set(call.id, { assistantIndex: index, remaining: 1 });
      }
    }
  }

  closeToolResultRun("the end of the history");
  return violations;
}
