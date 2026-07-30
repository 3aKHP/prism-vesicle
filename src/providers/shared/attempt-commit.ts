import type { ToolCall } from "../../core/tools";
import { cloneProviderStateEnvelope } from "./state";
import type { VesicleResponse } from "./types";

/**
 * Host-side transaction boundary for one logical provider generation.
 * Tool candidates may be observed while an attempt is in flight, but only the
 * terminal completed response can publish calls to the Agent Loop.
 */
export class ProviderAttemptCommitBarrier {
  private readonly attempts = new Map<number, ToolCall[]>();
  private readonly seenAttempts = new Set<number>();
  private closed = false;

  start(attempt: number): void {
    this.requireOpen();
    requireAttempt(attempt);
    if (this.seenAttempts.has(attempt)) throw new Error(`Provider attempt ${attempt} was already started.`);
    if (this.attempts.size > 0) throw new Error("A provider attempt is already pending and must be discarded before another attempt starts.");
    this.seenAttempts.add(attempt);
    this.attempts.set(attempt, []);
  }

  addCandidate(attempt: number, toolCall: ToolCall): void {
    this.requireOpen();
    const pending = this.attempts.get(attempt);
    if (!pending) throw new Error(`Provider attempt ${attempt} was not started before a tool candidate arrived.`);
    if (pending.some((call) => call.id === toolCall.id)) {
      throw new Error(`Provider attempt ${attempt} emitted duplicate tool call id ${toolCall.id}.`);
    }
    pending.push({ ...toolCall });
  }

  discard(attempt: number): void {
    this.requireOpen();
    requireAttempt(attempt);
    if (!this.attempts.has(attempt)) throw new Error(`Provider attempt ${attempt} is not pending and cannot be discarded.`);
    this.attempts.delete(attempt);
  }

  commit(response: VesicleResponse, attempt?: number): VesicleResponse {
    this.requireOpen();
    if (attempt === undefined && this.attempts.size > 0) {
      throw new Error("A terminal provider response must identify its pending attempt transaction.");
    }
    if (attempt !== undefined) {
      const pending = this.attempts.get(attempt);
      if (!pending) throw new Error(`Provider attempt ${attempt} completed without an active attempt transaction.`);
      if (pending.length > 0 && !sameToolCalls(pending, response.toolCalls ?? [])) {
        throw new Error(`Provider attempt ${attempt} completed with tool calls that do not match its pending candidates.`);
      }
    }
    const committed = {
      ...response,
      ...(response.toolCalls ? { toolCalls: response.toolCalls.map((call) => ({ ...call })) } : {}),
      ...(response.thinkingBlocks ? { thinkingBlocks: response.thinkingBlocks.map((block) => ({ ...block })) } : {}),
      ...(response.providerState ? { providerState: cloneProviderStateEnvelope(response.providerState) } : {}),
    };
    this.attempts.clear();
    this.closed = true;
    return committed;
  }

  private requireOpen(): void {
    if (this.closed) throw new Error("Provider attempt transaction is already committed.");
  }
}

function requireAttempt(attempt: number): void {
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error(`Provider attempt ${attempt} is invalid.`);
}

function sameToolCalls(expected: ToolCall[], actual: ToolCall[]): boolean {
  return expected.length === actual.length && expected.every((call, index) => {
    const candidate = actual[index];
    return candidate?.id === call.id && candidate.name === call.name && candidate.arguments === call.arguments;
  });
}
