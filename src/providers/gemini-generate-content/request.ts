import { ProviderError } from "../shared/errors";
import type { ProviderThinkingBlock, ReasoningTier, VesicleRequest } from "../shared/types";
import type { GeminiContent, GeminiPart } from "./types";

const defaultMaxOutputTokens = 4096;

export function toGeminiGenerateContentBody(request: VesicleRequest): Record<string, unknown> {
  const hasTools = Boolean(request.tools && request.tools.length > 0);
  return withoutUndefined({
    systemInstruction: request.system.length > 0 ? {
      parts: request.system.map((text) => ({ text })).filter((part) => part.text),
    } : undefined,
    contents: toGeminiContents(request.messages),
    generationConfig: withoutUndefined({
      temperature: request.generation?.temperature,
      maxOutputTokens: request.generation?.maxTokens ?? defaultMaxOutputTokens,
      thinkingConfig: geminiThinkingControl(request.generation?.reasoningTier, request.model.model),
    }),
    tools: hasTools ? [{
      functionDeclarations: request.tools?.map((tool) => ({
        name: tool.function.name,
        description: tool.function.description,
        parameters: sanitizeGeminiSchema(tool.function.parameters),
      })),
    }] : undefined,
  });
}

function toGeminiContents(messages: VesicleRequest["messages"]): GeminiContent[] {
  const serialized: GeminiContent[] = [];
  let pendingToolResults: GeminiPart[] = [];

  const flushToolResults = (): GeminiContent | undefined => {
    if (pendingToolResults.length === 0) return undefined;
    const message: GeminiContent = { role: "user", parts: pendingToolResults };
    serialized.push(message);
    pendingToolResults = [];
    return message;
  };

  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "tool") {
      pendingToolResults.push({
        functionResponse: {
          ...(message.toolCallId ? { id: message.toolCallId } : {}),
          name: toolNameFromCallId(serialized, message.toolCallId),
          response: { content: message.content },
        },
      });
      continue;
    }

    const flushedToolResults = flushToolResults();
    if (message.role === "assistant") {
      const replayParts = geminiReplayParts(message.thinkingBlocks);
      const parts = replayParts.length > 0
        ? replayParts
        : [
            ...(message.content ? [{ text: message.content }] : []),
            ...(message.toolCalls ?? []).map((call) => ({
              functionCall: {
                id: call.id,
                name: call.name,
                args: parseToolArguments(call.arguments),
              },
            })),
          ];
      serialized.push({ role: "model", parts: parts.length > 0 ? parts : [{ text: "" }] });
      continue;
    }

    if (flushedToolResults) {
      if (message.content) flushedToolResults.parts?.push({ text: message.content });
      continue;
    }
    serialized.push({ role: "user", parts: message.content ? [{ text: message.content }] : [{ text: "" }] });
  }

  flushToolResults();
  return serialized;
}

function toolNameFromCallId(contents: GeminiContent[], callId: string | undefined): string {
  if (!callId) return "";
  for (let contentIndex = contents.length - 1; contentIndex >= 0; contentIndex--) {
    const content = contents[contentIndex];
    if (content.role !== "model") continue;
    for (const part of content.parts ?? []) {
      const call = part.functionCall;
      if (call?.id === callId && typeof call.name === "string") return call.name;
    }
  }
  return "";
}

function geminiReplayParts(blocks: ProviderThinkingBlock[] | undefined): GeminiPart[] {
  const parts: GeminiPart[] = [];
  for (const block of blocks ?? []) {
    if (block.type !== "gemini_part") continue;
    if (!isRecord(block.part)) continue;
    parts.push(jsonClone(block.part) as GeminiPart);
  }
  return parts;
}

function geminiThinkingControl(tier: ReasoningTier | undefined, model: string): Record<string, unknown> | undefined {
  if (!tier) return undefined;
  const includeThoughts = tier !== "off";
  if (model.toLowerCase().startsWith("gemini-3")) {
    return withoutUndefined({
      thinkingLevel: thinkingLevelForTier(tier),
      includeThoughts,
    });
  }
  return withoutUndefined({
    thinkingBudget: tier === "off" ? 0 : thinkingBudgetForTier(tier),
    includeThoughts,
  });
}

function thinkingLevelForTier(tier: ReasoningTier): string {
  switch (tier) {
    case "off":
      return "minimal";
    case "low":
      return "low";
    case "midium":
      return "medium";
    case "high":
    case "xhigh":
    case "max":
      return "high";
  }
}

function thinkingBudgetForTier(tier: Exclude<ReasoningTier, "off">): number {
  switch (tier) {
    case "low":
      return 1024;
    case "midium":
      return 2048;
    case "high":
      return 4096;
    case "xhigh":
      return 8192;
    case "max":
      return 16000;
  }
}

const geminiAllowedSchemaKeys = new Set([
  "type",
  "format",
  "title",
  "description",
  "nullable",
  "enum",
  "default",
  "items",
  "properties",
  "required",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "minProperties",
  "maxProperties",
  "pattern",
  "example",
  "anyOf",
  "propertyOrdering",
  "minimum",
  "maximum",
]);

function sanitizeGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map((item) => sanitizeGeminiSchema(item));
  if (!isRecord(schema)) return schema;

  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!geminiAllowedSchemaKeys.has(key)) continue;
    if (key === "properties" && isRecord(value)) {
      cleaned[key] = Object.fromEntries(
        Object.entries(value).map(([name, child]) => [name, sanitizeGeminiSchema(child)]),
      );
      continue;
    }
    if (key === "items") {
      cleaned[key] = sanitizeGeminiSchema(value);
      continue;
    }
    if (key === "anyOf" && Array.isArray(value)) {
      cleaned[key] = value.map((item) => sanitizeGeminiSchema(item));
      continue;
    }
    cleaned[key] = value;
  }
  return cleaned;
}

function parseToolArguments(value: string): unknown {
  try {
    return JSON.parse(value || "{}");
  } catch {
    throw new ProviderError("Cannot serialize malformed tool-call arguments for Gemini generateContent.", {
      kind: "malformed_response",
    });
  }
}

function jsonClone(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

function withoutUndefined<T extends Record<string, unknown>>(source: T): T {
  return Object.fromEntries(Object.entries(source).filter(([, value]) => value !== undefined)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
