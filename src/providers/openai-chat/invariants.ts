import { PROVIDER_NATIVE_CHECKPOINT_KIND, type VesicleMessage } from "../shared/types";

/** An assistant tool-call turn whose result run is still open. */
type OpenCarrier = {
  index: number;
  /** Declared call ids awaiting a result, as id to unanswered count. */
  remaining: Map<string, number>;
};

/**
 * Pure OpenAI chat-completions protocol check over a host message history.
 *
 * `serializeOpenAIMessages` copies `toolCallId` and `tool_calls[].id` onto the
 * wire verbatim and never validates their pairing — its only failure mode is
 * an unmaterialized image attachment. A migrated history with broken tool
 * bookkeeping therefore surfaces later as an opaque provider error. This
 * validator fronts that boundary for session-migration preflight.
 *
 * Enforced contract (chat-completions tool-call rule): an assistant message
 * with `tool_calls` must be followed immediately by the `tool` messages
 * responding to each call id — no other serialized message may appear in
 * between, every declared id is answered exactly once, and ids only pair with
 * their own carrier. Ids may legitimately repeat across carriers: backends
 * that omit `delta.tool_calls[].id` get host- or server-minted `call_0`-style
 * ids that recur every round, so scoping is per carrier segment, never
 * global. Provider-native checkpoint markers are invisible here exactly as
 * the serializer filters them.
 *
 * Returns one human-readable violation per breach; an empty array means the
 * tool protocol invariants hold.
 */
export function validateOpenAIChatHistory(messages: VesicleMessage[]): string[] {
  const violations: string[] = [];
  let carrier: OpenCarrier | undefined;

  const closeCarrier = (boundary: string): void => {
    if (carrier && carrier.remaining.size > 0) {
      violations.push(
        `messages[${carrier.index}] (assistant) tool ${pluralize("call", "calls", carrier.remaining)} ${quotedIds(carrier.remaining).join(", ")}`
        + ` ${pluralize("has", "have", carrier.remaining)} no tool result before ${boundary}.`,
      );
    }
    carrier = undefined;
  };

  for (const [index, message] of messages.entries()) {
    if (message.kind === PROVIDER_NATIVE_CHECKPOINT_KIND) continue;

    if (message.role === "tool") {
      const toolCallId = message.toolCallId ?? "";
      if (!toolCallId) {
        violations.push(`message ${index} (tool) carries an empty toolCallId`);
        continue;
      }
      if (!carrier) {
        violations.push(`message ${index} (tool) answers toolCallId '${toolCallId}' with no preceding assistant tool-call message to declare it`);
        continue;
      }
      const outstanding = carrier.remaining.get(toolCallId) ?? 0;
      if (outstanding > 0) {
        if (outstanding === 1) carrier.remaining.delete(toolCallId);
        else carrier.remaining.set(toolCallId, outstanding - 1);
        continue;
      }
      violations.push(`message ${index} (tool) answers toolCallId '${toolCallId}', which the open assistant tool-call message ${carrier.index} does not have unanswered`);
      continue;
    }

    // Any non-tool message ends the run: the endpoint allows nothing but tool
    // results between a tool-call carrier and its answers.
    if (carrier) closeCarrier(`the ${message.role} message at index ${index}`);

    if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
      for (const [position, call] of message.toolCalls.entries()) {
        if (!call.id) {
          violations.push(`message ${index} (assistant) declares tool call '${call.name}' at toolCalls[${position}] with an empty id`);
        }
      }
      const counts = new Map<string, number>();
      for (const call of message.toolCalls) {
        if (call.id) counts.set(call.id, (counts.get(call.id) ?? 0) + 1);
      }
      carrier = { index, remaining: counts };
    }
  }

  closeCarrier("the end of the history");
  return violations;
}

function quotedIds(counts: Map<string, number>): string[] {
  return [...counts.entries()].flatMap(([id, count]) => Array.from({ length: count }, () => `'${id}'`));
}

function pluralize(singular: string, plural: string, counts: Map<string, number>): string {
  let total = 0;
  for (const count of counts.values()) total += count;
  return total === 1 ? singular : plural;
}
