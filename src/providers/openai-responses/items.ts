import { ProviderError } from "../shared/errors";
import type { ResponsesOutputItem } from "./types";

export function validateResponsesOutputItems(items: ResponsesOutputItem[], providerId?: string): ResponsesOutputItem[] {
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
        if (item.summary !== undefined && (!Array.isArray(item.summary)
          || item.summary.some((part) => part.type !== "summary_text" || typeof part.text !== "string"))) {
          fail("Provider response included malformed reasoning summary content.", providerId);
        }
        if (item.encrypted_content !== undefined && typeof item.encrypted_content !== "string") {
          fail("Provider response included malformed encrypted reasoning content.", providerId);
        }
        break;
      case "function_call":
        if (!item.call_id || !item.name || typeof item.arguments !== "string") {
          fail("Provider response included a malformed function_call Item.", providerId);
        }
        if (callIds.has(item.call_id)) fail(`Provider response repeated function call_id ${item.call_id}.`, providerId);
        callIds.add(item.call_id);
        break;
      default:
        fail(`Provider response included unsupported semantic Item ${item.type ?? "unknown"}.`, providerId);
    }
  }
  return items;
}

function fail(message: string, providerId?: string): never {
  throw new ProviderError(message, { kind: "malformed_response", providerId });
}
