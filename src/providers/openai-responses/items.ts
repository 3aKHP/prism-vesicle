import { ProviderError } from "../shared/errors";
import type { ResponsesProfile } from "../../config/env";
import { admitsEncryptedReasoningToken, isReasoningTextProfile, supportsResponsesWebSearch } from "./profiles";
import type { ResponsesOutputItem } from "./types";

export function validateResponsesOutputItems(
  items: ResponsesOutputItem[],
  providerId?: string,
  profile?: ResponsesProfile,
): ResponsesOutputItem[] {
  const callIds = new Set<string>();
  for (const item of items) {
    if (!item || typeof item !== "object") fail("Provider response included a malformed output Item.", providerId);
    switch (item.type) {
      case "message":
        if (item.role !== "assistant" || !Array.isArray(item.content)) fail("Provider response included a malformed message Item.", providerId);
        for (const part of item.content) {
          if (part.type === "output_text" && typeof part.text === "string") continue;
          if (part.type === "refusal" && typeof part.refusal === "string") continue;
          fail(`Provider response included unsupported message content ${part.type ?? "unknown"}.`, providerId);
        }
        break;
      case "reasoning":
        if (isReasoningTextProfile(profile)) {
          const encryptedContentOk = admitsEncryptedReasoningToken(profile)
            ? item.encrypted_content === undefined || typeof item.encrypted_content === "string"
            : item.encrypted_content === undefined;
          if ((item.summary !== undefined && (!Array.isArray(item.summary) || item.summary.length > 0))
            || !encryptedContentOk
            || !Array.isArray(item.content)
            || item.content.some((part) => part.type !== "reasoning_text" || typeof part.text !== "string")) {
            fail(profile === "mimo-subset-2026-07-30"
              ? "Provider response included unsupported MiMo reasoning content."
              : "Provider response included unsupported DeepSeek reasoning content.", providerId);
          }
          break;
        }
        if (item.summary !== undefined && (!Array.isArray(item.summary)
          || item.summary.some((part) => part.type !== "summary_text" || typeof part.text !== "string"))) {
          fail("Provider response included malformed reasoning summary content.", providerId);
        }
        if (item.encrypted_content !== undefined && typeof item.encrypted_content !== "string") {
          fail("Provider response included malformed encrypted reasoning content.", providerId);
        }
        if (item.content !== undefined && (!Array.isArray(item.content) || item.content.length > 0)) {
          fail("Provider response included unsupported reasoning content.", providerId);
        }
        break;
      case "function_call":
        if (!item.call_id || !item.name || typeof item.arguments !== "string") {
          fail("Provider response included a malformed function_call Item.", providerId);
        }
        if (callIds.has(item.call_id)) fail(`Provider response repeated function call_id ${item.call_id}.`, providerId);
        callIds.add(item.call_id);
        break;
      case "web_search_call":
        // Status and action stay union-tolerant across OpenAI and DeepSeek:
        // their documented status enums differ, and action variants are
        // replayed verbatim rather than narrowed to one dialect.
        if (!supportsResponsesWebSearch(profile)
          || typeof item.id !== "string" || !item.id
          || typeof item.status !== "string" || !item.status
          || !item.action || typeof item.action !== "object" || Array.isArray(item.action)) {
          fail("Provider response included a malformed web_search_call Item.", providerId);
        }
        break;
      default:
        fail(`Provider response included unsupported semantic Item ${item.type ?? "unknown"}.`, providerId);
    }
  }
  return items;
}

/** Validate the canonical input window returned by `/responses/compact`. */
export function validateResponsesCompactItems(items: ResponsesOutputItem[], providerId?: string): ResponsesOutputItem[] {
  let compactionItems = 0;
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item) || typeof item.type !== "string" || !item.type) {
      fail("Provider compaction included a malformed Item.", providerId);
    }
    if (item.type === "compaction") {
      if (typeof item.encrypted_content !== "string" || item.encrypted_content.length === 0) {
        fail("Provider compaction included a malformed compaction Item.", providerId);
      }
      compactionItems += 1;
    }
  }
  if (compactionItems !== 1) {
    fail("Provider compaction did not return exactly one encrypted compaction Item.", providerId);
  }
  return items;
}

function fail(message: string, providerId?: string): never {
  throw new ProviderError(message, { kind: "malformed_response", providerId });
}
