import type { ProviderThinkingBlock } from "./types";

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
  }
  const text = parts.join("\n").trim();
  return text || undefined;
}
