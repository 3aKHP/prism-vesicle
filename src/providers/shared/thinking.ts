import type { ProviderThinkingBlock } from "./types";

/**
 * Strict shape guard for thinking blocks reloaded from durable session state.
 * Every persistence reader (history projection, quality recovery, compact
 * checkpoints) filters through this single list so a new provider-native
 * block type cannot drift across copies again (#243). Unknown or malformed
 * entries are rejected: silently dropped by the projection readers, and
 * rejected fail-closed by the compact-checkpoint parser.
 */
export function isKnownThinkingBlock(value: unknown): value is ProviderThinkingBlock {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const block = value as ProviderThinkingBlock;
  if (block.type === "reasoning") return typeof block.reasoningContent === "string";
  if (block.type === "thinking") return typeof block.thinking === "string";
  if (block.type === "redacted_thinking") return typeof block.data === "string";
  if (block.type === "thought_summary") return typeof block.text === "string" || typeof block.summary === "string";
  // Gemini replays provider-native parts (thought text, functionCall) with
  // their thoughtSignature verbatim; only a structured part can carry one.
  return block.type === "gemini_part" && isRecord(block.part);
}

export function thinkingBlocksFromReasoningContent(reasoningContent: string | undefined): ProviderThinkingBlock[] | undefined {
  if (!reasoningContent) return undefined;
  return [{ type: "reasoning", reasoningContent }];
}

export function reasoningContentFromThinkingBlocks(blocks: ProviderThinkingBlock[] | undefined): string | undefined {
  const parts: string[] = [];
  for (const block of blocks ?? []) {
    if (block.type !== "reasoning") continue;
    const reasoningContent = block.reasoningContent;
    if (typeof reasoningContent === "string" && reasoningContent) parts.push(reasoningContent);
  }
  const text = parts.join("\n").trim();
  return text || undefined;
}

export function displayTextFromThinkingBlocks(blocks: ProviderThinkingBlock[] | undefined): string | undefined {
  const parts: string[] = [];
  for (const block of blocks ?? []) {
    if (block.type === "reasoning") {
      const reasoningContent = block.reasoningContent;
      if (typeof reasoningContent === "string" && reasoningContent) parts.push(reasoningContent);
      continue;
    }
    if (block.type === "thinking") {
      const thinking = block.thinking;
      if (typeof thinking === "string" && thinking) parts.push(thinking);
      continue;
    }
    if (block.type === "redacted_thinking") {
      parts.push("[redacted thinking]");
      continue;
    }
    if (block.type === "thought_summary") {
      const text = block.text ?? block.summary;
      if (typeof text === "string" && text) parts.push(text);
      continue;
    }
    if (block.type === "gemini_part" && isRecord(block.part)) {
      const part = block.part;
      if (part.thought === true && typeof part.text === "string" && part.text) parts.push(part.text);
      continue;
    }
  }
  const text = parts.join("\n").trim();
  return text || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
