import { isDeepStrictEqual } from "node:util";
import { ProviderError } from "../shared/errors";
import { readSseEvents } from "../shared/sse";
import type { ProviderStreamEvent } from "../shared/types";
import type { ResponsesProfile } from "../../config/env";
import { responseFromResponsesBody } from "./response";
import type { ResponsesBody, ResponsesEvent, ResponsesOutputItem } from "./types";

type StreamContext = {
  requestId: string;
  providerId: string;
  model: string;
  endpointFingerprint: string;
  attempt?: number;
  profile?: ResponsesProfile;
  allowEmptyOutput?: boolean;
};

export async function* readResponsesStream(response: Response, context: StreamContext): AsyncIterable<ProviderStreamEvent> {
  if (!response.body) throw new ProviderError("Provider streaming response did not include a body.", {
    kind: "stream_error", providerId: context.providerId,
  });
  const attempt = context.attempt ?? 1;
  yield { type: "attempt_started", attempt };
  let terminal: ResponsesBody | undefined;
  let streamedContent = "";
  let streamedReasoning = "";
  const streamedArguments = new Map<number, string>();
  const relayCompletedItems: ResponsesOutputItem[] = [];
  let expectedSequence = 0;
  for await (const block of readSseEvents(response.body)) {
    const event = parseEvent(block.data, context.providerId);
    if (!event.type) throw malformed("Provider stream event did not include a type.", context.providerId);
    if (terminal) throw malformed(`Provider stream emitted ${event.type} after its terminal response.completed event.`, context.providerId);
    if (event.sequence_number !== undefined && event.sequence_number !== expectedSequence) {
      throw malformed(`Provider stream sequence jumped from ${expectedSequence} to ${event.sequence_number}.`, context.providerId);
    }
    if (event.sequence_number !== undefined) expectedSequence += 1;
    switch (event.type) {
      case "response.output_text.delta":
      case "response.refusal.delta":
        if (typeof event.delta !== "string") throw malformed("Output text delta was malformed.", context.providerId);
        streamedContent += event.delta;
        yield { type: "content_delta", delta: event.delta };
        break;
      case "response.reasoning_summary_text.delta":
        if (isReasoningTextProfile(context.profile)) {
          throw malformed(`Unsupported semantic Responses event: ${event.type}.`, context.providerId);
        }
        if (typeof event.delta !== "string") throw malformed("Reasoning delta was malformed.", context.providerId);
        streamedReasoning += event.delta;
        yield { type: "reasoning_delta", delta: event.delta };
        break;
      case "response.reasoning_text.delta":
        if (!isReasoningTextProfile(context.profile)) {
          throw malformed(`Unsupported semantic Responses event: ${event.type}.`, context.providerId);
        }
        if (typeof event.delta !== "string") throw malformed("Reasoning delta was malformed.", context.providerId);
        streamedReasoning += event.delta;
        yield { type: "reasoning_delta", delta: event.delta };
        break;
      case "response.function_call_arguments.delta":
        if (typeof event.output_index !== "number" || typeof event.delta !== "string") {
          throw malformed("Function argument delta was malformed.", context.providerId);
        }
        streamedArguments.set(event.output_index, `${streamedArguments.get(event.output_index) ?? ""}${event.delta}`);
        yield { type: "tool_call_delta", index: event.output_index, argumentsDelta: event.delta };
        break;
      case "response.output_item.done":
        if (context.profile === "codex-http-relay") {
          if (!event.item) throw malformed("Completed codex-http-relay output Item was missing.", context.providerId);
          const outputIndex = event.output_index ?? relayCompletedItems.length;
          if (!Number.isInteger(outputIndex) || outputIndex !== relayCompletedItems.length) {
            throw malformed(`Completed codex-http-relay output Item index ${String(outputIndex)} did not match the expected index ${relayCompletedItems.length}.`, context.providerId);
          }
          relayCompletedItems.push(event.item);
        }
        if (event.item?.type === "function_call") {
          if (!event.item.call_id || !event.item.name || typeof event.item.arguments !== "string") {
            throw malformed("Completed function_call Item was malformed.", context.providerId);
          }
          yield {
            type: "tool_call_candidate",
            attempt,
            toolCall: { id: event.item.call_id, name: event.item.name, arguments: event.item.arguments },
          };
        }
        break;
      case "response.completed":
        if (!event.response) throw malformed("Completed event omitted the final response.", context.providerId);
        terminal = event.response;
        break;
      case "response.failed":
        {
          const code = event.response?.error?.code;
          throw new ProviderError(`Provider stream terminated with ${event.type}: ${event.response?.error?.message ?? event.response?.incomplete_details?.reason ?? "unknown"}.`, {
            kind: "http_error", providerId: context.providerId, code,
            retryable: event.response?.error != null && !isFatalResponseFailure(code),
          });
        }
      case "response.incomplete":
        throw new ProviderError(`Provider stream terminated with ${event.type}: ${event.response?.incomplete_details?.reason ?? "unknown"}.`, {
          kind: "http_error", providerId: context.providerId,
        });
      case "error":
        throw new ProviderError(`Provider stream failed${event.error?.code ? ` (${event.error.code})` : ""}: ${event.error?.message ?? "unknown error"}.`, {
          kind: "stream_error", providerId: context.providerId, code: event.error?.code,
        });
      default:
        if (context.profile === "codex-http-relay"
          && (event.type === "codex.rate_limits"
            || event.type === "codex.response.metadata"
            || event.type === "responsesapi.websocket_timing")) break;
        if (!isKnownAdditiveEvent(event.type, context.profile)) throw malformed(`Unsupported semantic Responses event: ${event.type}.`, context.providerId);
    }
  }
  if (!terminal) throw new ProviderError("Provider stream ended before response.completed.", {
    kind: "stream_error", providerId: context.providerId,
  });
  const effectiveTerminal = reconcileRelayTerminal(terminal, relayCompletedItems, context);
  const completed = responseFromResponsesBody(effectiveTerminal, context);
  if (streamedContent && streamedContent !== completed.content) {
    throw malformed("Streamed output text did not match the completed response Items.", context.providerId);
  }
  if (streamedReasoning && streamedReasoning !== completed.reasoningContent) {
    throw malformed("Streamed reasoning did not match the completed response Items.", context.providerId);
  }
  const output = effectiveTerminal.output ?? [];
  for (const [outputIndex, argumentsText] of streamedArguments) {
    const item = output[outputIndex];
    if (item?.type !== "function_call" || item.arguments !== argumentsText) {
      throw malformed(`Streamed function arguments at output index ${outputIndex} did not match the completed response Item.`, context.providerId);
    }
  }
  yield { type: "complete", attempt, response: completed };
}

function reconcileRelayTerminal(
  terminal: ResponsesBody,
  completedItems: ResponsesOutputItem[],
  context: StreamContext,
): ResponsesBody {
  if (context.profile !== "codex-http-relay" || completedItems.length === 0) return terminal;
  if (!terminal.output || terminal.output.length === 0) return { ...terminal, output: completedItems };
  if (!isDeepStrictEqual(terminal.output, completedItems)) {
    throw malformed("Completed codex-http-relay output Items did not match response.output_item.done Items.", context.providerId);
  }
  return terminal;
}

function parseEvent(payload: string, providerId: string): ResponsesEvent {
  try {
    return JSON.parse(payload) as ResponsesEvent;
  } catch (error) {
    throw new ProviderError("Provider stream delivered unparseable event data.", {
      kind: "malformed_response", providerId, cause: error,
    });
  }
}

function isKnownAdditiveEvent(type: string, profile: ResponsesProfile | undefined): boolean {
  return type === "response.created" || type === "response.in_progress"
    || type === "response.output_item.added" || type === "response.content_part.added"
    || type === "response.content_part.done" || type === "response.output_text.done"
    || type === "response.refusal.done"
    || (!isReasoningTextProfile(profile) && (type === "response.reasoning_summary_part.added"
      || type === "response.reasoning_summary_part.done" || type === "response.reasoning_summary_text.done"))
    || (isReasoningTextProfile(profile) && type === "response.reasoning_text.done")
    || type === "response.function_call_arguments.done";
}

function isReasoningTextProfile(profile: ResponsesProfile | undefined): boolean {
  return profile === "mimo-subset-2026-07-30"
    || profile === "deepseek-subset-2026-07-31";
}

function isFatalResponseFailure(code: string | undefined): boolean {
  return code === "context_length_exceeded"
    || code === "insufficient_quota"
    || code === "usage_not_included"
    || code === "cyber_policy"
    || code === "invalid_prompt"
    || code === "bio_policy";
}

function malformed(message: string, providerId: string): never {
  throw new ProviderError(message, { kind: "malformed_response", providerId });
}
