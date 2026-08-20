import { ProviderError } from "../shared/errors";
import { parseProviderStateEnvelope, providerStateEnvelopeVersion } from "../shared/state";
import { thinkingBlocksFromReasoningContent } from "../shared/thinking";
import type { VesicleResponse, WebSearchCitation, WebSearchReport } from "../shared/types";
import type { ResponsesProfile } from "../../config/env";
import { validateResponsesOutputItems } from "./items";
import { isReasoningTextProfile } from "./profiles";
import { openAIResponsesProtocol, type ResponsesBody, type ResponsesOutputItem } from "./types";
import { usageFromResponses } from "./usage";

type ResponseContext = {
  requestId: string;
  providerId: string;
  model: string;
  endpointFingerprint: string;
  /** WebSocket generate=false is successful with an empty output array. */
  allowEmptyOutput?: boolean;
  profile?: ResponsesProfile;
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

  const output = validateResponsesOutputItems(body.output, context.providerId, context.profile);
  const content = messageText(output);
  const reasoningContent = reasoningText(output, context.profile);
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
    payload: { version: 1, profile: context.profile ?? "openai-public", responseId: body.id, outputItems: output },
  });
  const webSearch = webSearchReport(output, context.providerId);
  return {
    id: body.id ?? context.requestId,
    content,
    ...(reasoningContent ? { reasoningContent, thinkingBlocks: thinkingBlocksFromReasoningContent(reasoningContent) } : {}),
    ...(toolCalls.length ? { toolCalls } : {}),
    ...(webSearch ? { webSearch } : {}),
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

/**
 * DeepSeek's search mode embeds its internal call id as a pseudo entry of
 * action.queries (`ws_call_id=...`); it is a transport artifact, not a query
 * the model authored, so it stays out of the audit floor.
 */
function addQuery(queries: Set<string>, query: string): void {
  if (!query.startsWith("ws_call_id=")) queries.add(query);
}

/**
 * Normalize admitted web_search_call Items into the audit report. A report is
 * only produced when at least one executed query is recoverable — the session
 * projector treats queries as the audit floor and would drop an empty report
 * on replay anyway.
 */
function webSearchReport(items: ResponsesOutputItem[], providerId: string): WebSearchReport | undefined {
  const calls = items.filter((item) => item.type === "web_search_call");
  if (calls.length === 0) return undefined;
  const queries = new Set<string>();
  for (const item of calls) {
    const action = item.action as Record<string, unknown> | undefined;
    if (typeof action?.query === "string" && action.query) addQuery(queries, action.query);
    if (Array.isArray(action?.queries)) {
      for (const query of action.queries) {
        if (typeof query === "string" && query) addQuery(queries, query);
      }
    }
  }
  if (queries.size === 0) return undefined;
  const citations = items.filter((item) => item.type === "message").flatMap((item) => item.content ?? [])
    .flatMap((part) => part.annotations ?? [])
    .filter((annotation) => annotation.type === "url_citation")
    .flatMap((annotation): WebSearchCitation[] => {
      if (typeof annotation.url !== "string" || !annotation.url || typeof annotation.title !== "string") return [];
      return [{
        url: annotation.url,
        title: annotation.title,
        ...(typeof annotation.start_index === "number" ? { startIndex: annotation.start_index } : {}),
        ...(typeof annotation.end_index === "number" ? { endIndex: annotation.end_index } : {}),
      }];
    });
  return {
    provider: providerId,
    queries: [...queries],
    ...(citations.length ? { citations } : {}),
    calls: calls.map((item) => ({
      id: item.id!,
      status: item.status!,
      action: item.action as Record<string, unknown>,
    })),
  };
}

function reasoningText(items: ResponsesOutputItem[], profile: ResponsesProfile | undefined): string {
  return items.filter((item) => item.type === "reasoning").flatMap((item) => (
    isReasoningTextProfile(profile) ? item.content ?? [] : item.summary ?? []
  ))
    .map((part) => part.text ?? "").join("");
}

function malformed(message: string, context: ResponseContext): never {
  throw new ProviderError(message, { kind: "malformed_response", providerId: context.providerId });
}

export async function readResponsesErrorMessage(response: Response): Promise<string> {
  const body = await response.json().catch(() => undefined) as ResponsesBody | undefined;
  return body?.error?.message ?? response.statusText;
}
