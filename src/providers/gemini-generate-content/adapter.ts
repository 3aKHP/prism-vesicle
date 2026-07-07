import type { VesicleConfig } from "../../config/env";
import type { ToolCall } from "../../core/tools";
import { ProviderError } from "../shared/errors";
import { displayTextFromThinkingBlocks } from "../shared/thinking";
import type { ProviderAdapter, ProviderThinkingBlock, ReasoningTier, VesicleRequest, VesicleResponse } from "../shared/types";

type GeminiPart = {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: {
    id?: string;
    name?: string;
    args?: unknown;
  };
  functionResponse?: {
    id?: string;
    name?: string;
    response?: unknown;
  };
  [key: string]: unknown;
};

type GeminiContent = {
  role?: "user" | "model";
  parts?: GeminiPart[];
};

type GeminiCandidate = {
  content?: GeminiContent;
  finishReason?: string;
};

type GeminiResponse = {
  candidates?: GeminiCandidate[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
  error?: {
    message?: string;
  };
};

const defaultMaxOutputTokens = 4096;

export class GeminiGenerateContentAdapter implements ProviderAdapter {
  readonly id = "gemini-generate-content";

  constructor(private readonly config: VesicleConfig) {}

  async complete(request: VesicleRequest): Promise<VesicleResponse> {
    this.requireApiKey();

    const response = await fetch(this.url(request.model.model, "generateContent"), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(toGeminiGenerateContentBody(request)),
    });
    const body = await response.json().catch(() => undefined) as GeminiResponse | undefined;
    if (!response.ok) {
      const providerMessage = body?.error?.message ?? response.statusText;
      throw new ProviderError(`Provider request failed (${response.status}): ${providerMessage}`, {
        kind: "http_error",
        providerId: this.config.providerId,
        status: response.status,
      });
    }

    return responseFromGeminiBody(body, request.id, this.config.providerId);
  }

  private url(model: string, action: "generateContent" | "streamGenerateContent"): string {
    const modelPath = model.startsWith("models/") ? model : `models/${model}`;
    return `${this.config.baseUrl}/${modelPath}:${action}`;
  }

  private headers(): Record<string, string> {
    const apiKey = this.config.apiKey ?? "";
    const authMethod = this.config.authMethod ?? "x-goog-api-key";
    return {
      "Content-Type": "application/json",
      ...(authMethod === "bearer" ? { "Authorization": `Bearer ${apiKey}` } : {}),
      ...(authMethod === "x-api-key" ? { "x-api-key": apiKey } : {}),
      ...(authMethod === "x-goog-api-key" ? { "x-goog-api-key": apiKey } : {}),
    };
  }

  private requireApiKey(): void {
    if (this.config.apiKey) return;
    throw new ProviderError(`${this.config.apiKeyLabel ?? "provider API key"} is required before making a provider request.`, {
      kind: "missing_credentials",
      providerId: this.config.providerId,
    });
  }
}

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

function responseFromGeminiBody(
  body: GeminiResponse | undefined,
  fallbackId: string,
  providerId?: string,
): VesicleResponse {
  const candidate = body?.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];
  const textParts: string[] = [];
  const toolCalls: ToolCall[] = [];
  const normalizedParts = parts.map((part, index) => normalizeGeminiPart(part, index));
  const needsReplay = normalizedParts.some((part) => part.thought === true || typeof part.thoughtSignature === "string");
  const thinkingBlocks: ProviderThinkingBlock[] = needsReplay
    ? normalizedParts.map((part) => ({ type: "gemini_part", part: jsonClone(part) }))
    : [];

  for (let index = 0; index < normalizedParts.length; index++) {
    const part = normalizedParts[index];
    if (part.text && part.thought !== true) textParts.push(part.text);
    if (part.functionCall) {
      const name = part.functionCall.name?.trim();
      if (!name) {
        throw new ProviderError("Provider response included a functionCall without name.", {
          kind: "malformed_response",
          providerId,
        });
      }
      toolCalls.push({
        id: part.functionCall.id || `gemini_tool_${index + 1}`,
        name,
        arguments: jsonString(part.functionCall.args),
      });
    }
  }

  const content = textParts.join("");
  const reasoningContent = displayTextFromThinkingBlocks(thinkingBlocks);
  if (!content && toolCalls.length === 0) {
    throw new ProviderError("Provider response did not include assistant content or tool calls.", {
      kind: "malformed_response",
      providerId,
    });
  }

  return {
    id: fallbackId,
    content,
    ...(reasoningContent ? { reasoningContent } : {}),
    ...(thinkingBlocks.length > 0 ? { thinkingBlocks } : {}),
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    finishReason: candidate?.finishReason,
    raw: body,
    usage: {
      inputTokens: body?.usageMetadata?.promptTokenCount,
      outputTokens: body?.usageMetadata?.candidatesTokenCount,
      totalTokens: body?.usageMetadata?.totalTokenCount,
    },
  };
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

function normalizeGeminiPart(part: GeminiPart, index: number): GeminiPart {
  if (!part.functionCall || part.functionCall.id) return part;
  return {
    ...part,
    functionCall: {
      ...part.functionCall,
      id: `gemini_tool_${index + 1}`,
    },
  };
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

function jsonString(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
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
