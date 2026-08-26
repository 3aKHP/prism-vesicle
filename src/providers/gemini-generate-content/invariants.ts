import type { VesicleMessage } from "../shared/types";

/**
 * Messages with this host-only kind are skipped by the Gemini serializer
 * without ending the pending functionResponse batch, so they are transparent
 * to these invariants too. Kept as a literal to keep this module type-import
 * only; it must stay in sync with `PROVIDER_NATIVE_CHECKPOINT_KIND` in
 * `providers/shared/types`.
 */
const providerNativeCheckpointKind = "provider-native-checkpoint";

/** The assistant tool-call turn whose result batch is still open. */
type OpenToolBatch = {
  /** Index of the assistant message that issued the tool calls. */
  index: number;
  /** Tool-call ids still awaiting a result, as id to unanswered count. */
  remaining: Map<string, number>;
  /** Every tool-call id the assistant message issued, as id to count. */
  issued: Map<string, number>;
  /** True once an out-of-turn message already reported this batch as broken. */
  interrupted: boolean;
};

/**
 * Pure protocol-invariant validator for a host message history destined for
 * the Gemini `generateContent` endpoint. The sibling serializer in
 * `request.ts` never rejects a structurally broken tool-call/response
 * sequence on its own — it forwards what the host recorded and the endpoint
 * answers with HTTP 400 — so migration preflight needs this separate check.
 *
 * Enforced contract (docs/dev/PROVIDERS.md § Protocol Mapping):
 * - each assistant tool-call turn is followed by a consecutive tool-result
 *   batch containing exactly one result per tool call, matched by id;
 * - no user or assistant message may appear before that batch completes,
 *   because the endpoint rejects a split parallel response batch.
 *
 * Returns one human-readable violation per defect, naming the message index
 * and the ids involved. An empty array means the history is protocol-valid.
 */
export function validateGeminiHistory(messages: VesicleMessage[]): string[] {
  const violations: string[] = [];
  let batch: OpenToolBatch | undefined;

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.kind === providerNativeCheckpointKind) continue;
    if (message.role === "system") continue;

    if (message.role === "tool") {
      if (batch === undefined) {
        violations.push(message.toolCallId
          ? `Tool result at index ${index} ("${message.toolCallId}") has no preceding assistant tool-call turn to answer.`
          : `Tool result at index ${index} has no toolCallId and no preceding assistant tool-call turn to answer.`);
        continue;
      }
      if (!message.toolCallId) {
        violations.push(`Tool result at index ${index} has no toolCallId, so it cannot answer a tool call from the assistant message at index ${batch.index}.`);
        continue;
      }
      const outstanding = batch.remaining.get(message.toolCallId) ?? 0;
      if (outstanding > 0) {
        if (outstanding === 1) batch.remaining.delete(message.toolCallId);
        else batch.remaining.set(message.toolCallId, outstanding - 1);
        continue;
      }
      violations.push((batch.issued.get(message.toolCallId) ?? 0) > 0
        ? `Tool result at index ${index} ("${message.toolCallId}") duplicates an earlier result for a tool call from the assistant message at index ${batch.index}.`
        : `Tool result at index ${index} ("${message.toolCallId}") matches no unresolved tool call from the assistant message at index ${batch.index}.`);
      continue;
    }

    if (batch !== undefined && batch.remaining.size > 0 && !batch.interrupted) {
      violations.push(
        `${message.role === "assistant" ? "Assistant" : "User"} message at index ${index} appears before the tool-result batch for the assistant message at index ${batch.index} completes`
          + `; missing ${pluralized("result", "results", batch.remaining)} for tool ${pluralized("call", "calls", batch.remaining)} ${quotedIds(batch.remaining).join(", ")}.`,
      );
      batch.interrupted = true;
    }

    const calls = message.role === "assistant" ? (message.toolCalls ?? []) : [];
    if (calls.length > 0) {
      for (const [position, call] of calls.entries()) {
        if (!call.id) {
          violations.push(`Assistant message at index ${index} declares tool call '${call.name}' at toolCalls[${position}] with an empty id, which cannot be answered by a functionResponse.`);
        }
      }
      const counts = callIdCounts(calls);
      batch = { index, remaining: new Map(counts), issued: counts, interrupted: false };
    }
  }

  if (batch !== undefined && batch.remaining.size > 0 && !batch.interrupted) {
    violations.push(
      `Assistant message at index ${batch.index} has tool ${pluralized("call", "calls", batch.remaining)} ${quotedIds(batch.remaining).join(", ")}`
        + ` with no tool result in the immediately following batch.`,
    );
  }
  return violations;
}

function callIdCounts(calls: NonNullable<VesicleMessage["toolCalls"]>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const call of calls) counts.set(call.id, (counts.get(call.id) ?? 0) + 1);
  return counts;
}

function quotedIds(counts: Map<string, number>): string[] {
  return [...counts.entries()].flatMap(([id, count]) => Array.from({ length: count }, () => `"${id}"`));
}

function pluralized(singular: string, plural: string, counts: Map<string, number>): string {
  let total = 0;
  for (const count of counts.values()) total += count;
  return total === 1 ? singular : plural;
}
