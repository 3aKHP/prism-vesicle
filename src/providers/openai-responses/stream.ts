import { ProviderError } from "../shared/errors";
import { readSseEvents } from "../shared/sse";
import type { ProviderStreamEvent } from "../shared/types";
import type { ResponsesProfile } from "../../config/env";
import { responseFromResponsesBody } from "./response";
import type { ResponsesBody, ResponsesEvent } from "./types";

type StreamContext = {
  requestId: string;
  providerId: string;
  model: string;
  endpointFingerprint: string;
  attempt?: number;
  profile?: ResponsesProfile;
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
      case "response.reasoning_text.delta":
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
        throw new ProviderError(`Provider stream terminated with ${event.type}: ${event.response?.error?.message ?? event.response?.incomplete_details?.reason ?? "unknown"}.`, {
          kind: "http_error", providerId: context.providerId,
        });
      case "response.incomplete":
        throw new ProviderError(`Provider stream terminated with ${event.type}: ${event.response?.incomplete_details?.reason ?? "unknown"}.`, {
          kind: "http_error", providerId: context.providerId,
        });
      case "error":
        throw new ProviderError(`Provider stream failed: ${event.error?.message ?? "unknown error"}.`, {
          kind: "stream_error", providerId: context.providerId,
        });
      default:
        if (context.profile === "codex-http-relay"
          && (event.type === "codex.rate_limits" || event.type === "codex.response.metadata")) break;
        if (!isKnownAdditiveEvent(event.type)) throw malformed(`Unsupported semantic Responses event: ${event.type}.`, context.providerId);
    }
  }
  if (!terminal) throw new ProviderError("Provider stream ended before response.completed.", {
    kind: "stream_error", providerId: context.providerId,
  });
  const completed = responseFromResponsesBody(terminal, context);
  if (streamedContent && streamedContent !== completed.content) {
    throw malformed("Streamed output text did not match the completed response Items.", context.providerId);
  }
  if (streamedReasoning && streamedReasoning !== completed.reasoningContent) {
    throw malformed("Streamed reasoning did not match the completed response Items.", context.providerId);
  }
  const output = terminal.output ?? [];
  for (const [outputIndex, argumentsText] of streamedArguments) {
    const item = output[outputIndex];
    if (item?.type !== "function_call" || item.arguments !== argumentsText) {
      throw malformed(`Streamed function arguments at output index ${outputIndex} did not match the completed response Item.`, context.providerId);
    }
  }
  yield { type: "complete", attempt, response: completed };
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

function isKnownAdditiveEvent(type: string): boolean {
  return type === "response.created" || type === "response.in_progress"
    || type === "response.output_item.added" || type === "response.content_part.added"
    || type === "response.content_part.done" || type === "response.output_text.done"
    || type === "response.refusal.done"
    || type === "response.reasoning_summary_part.added" || type === "response.reasoning_summary_part.done"
    || type === "response.reasoning_summary_text.done" || type === "response.function_call_arguments.done";
}

function malformed(message: string, providerId: string): never {
  throw new ProviderError(message, { kind: "malformed_response", providerId });
}
