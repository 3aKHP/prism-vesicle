import { ProviderError } from "../shared/errors";
import { parseProviderStateEnvelope, providerStateEnvelopeVersion } from "../shared/state";
import { thinkingBlocksFromReasoningContent } from "../shared/thinking";
import type { VesicleResponse } from "../shared/types";
import { validateResponsesOutputItems } from "./items";
import { openAIResponsesProtocol, type ResponsesBody, type ResponsesOutputItem } from "./types";
import { usageFromResponses } from "./usage";

type ResponseContext = {
  requestId: string;
  providerId: string;
  model: string;
  endpointFingerprint: string;
  /** WebSocket generate=false is successful with an empty output array. */
  allowEmptyOutput?: boolean;
};

export function responseFromResponsesBody(body: ResponsesBody | undefined, context: ResponseContext): VesicleResponse {
  if (!body || !Array.isArray(body.output)) return malformed("Provider response did not include ordered output Items.", context);
  if (body.status !== "completed") {
    const detail = body.error?.message ?? body.incomplete_details?.reason ?? body.status ?? "unknown";
    throw new ProviderError(`Provider response did not complete: ${detail}.`, {
      kind: body.status === "failed" ? "http_error" : "malformed_response",
      providerId: context.providerId,
    });
  }

  const output = validateResponsesOutputItems(body.output, context.providerId);
  const content = messageText(output);
  const reasoningContent = reasoningText(output);
  const callIds = new Set<string>();
  const toolCalls = output.filter((item) => item.type === "function_call").map((item) => {
    if (!item.call_id || !item.name || typeof item.arguments !== "string") {
      throw new ProviderError("Provider response included a malformed function_call Item.", {
        kind: "malformed_response",
        providerId: context.providerId,
      });
    }
    if (callIds.has(item.call_id)) {
      throw new ProviderError(`Provider response repeated function call_id ${item.call_id}.`, {
        kind: "malformed_response",
        providerId: context.providerId,
      });
    }
    callIds.add(item.call_id);
    return { id: item.call_id, name: item.name, arguments: item.arguments };
  });
  if (!context.allowEmptyOutput && !content && toolCalls.length === 0) {
    return malformed("Provider response did not include assistant content or function calls.", context);
  }

  const providerState = parseProviderStateEnvelope({
    version: providerStateEnvelopeVersion,
    protocol: openAIResponsesProtocol,
    providerId: context.providerId,
    model: context.model,
    endpointFingerprint: context.endpointFingerprint,
    payload: { version: 1, responseId: body.id, outputItems: output },
  });
  return {
    id: body.id ?? context.requestId,
    content,
    ...(reasoningContent ? { reasoningContent, thinkingBlocks: thinkingBlocksFromReasoningContent(reasoningContent) } : {}),
    ...(toolCalls.length ? { toolCalls } : {}),
    finishReason: body.status,
    raw: body,
    usage: usageFromResponses(body.usage),
    providerState,
  };
}

function messageText(items: ResponsesOutputItem[]): string {
  return items.filter((item) => item.type === "message").flatMap((item) => item.content ?? [])
    .filter((part) => part.type === "output_text" || part.type === "refusal")
    .map((part) => part.type === "refusal" ? part.refusal ?? "" : part.text ?? "").join("");
}

function reasoningText(items: ResponsesOutputItem[]): string {
  return items.filter((item) => item.type === "reasoning").flatMap((item) => item.summary ?? [])
    .map((part) => part.text ?? "").join("");
}

function malformed(message: string, context: ResponseContext): never {
  throw new ProviderError(message, { kind: "malformed_response", providerId: context.providerId });
}

export async function readResponsesErrorMessage(response: Response): Promise<string> {
  const body = await response.json().catch(() => undefined) as ResponsesBody | undefined;
  return body?.error?.message ?? response.statusText;
}
