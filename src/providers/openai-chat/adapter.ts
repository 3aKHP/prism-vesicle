import type { VesicleConfig } from "../../config/env";
import type { ProviderAdapter, VesicleRequest, VesicleResponse } from "../shared/types";

type ChatCompletionChoice = {
  finish_reason?: string | null;
  message?: {
    content?: string | null;
    tool_calls?: Array<{
      id: string;
      type: "function";
      function: {
        name: string;
        arguments: string;
      };
    }>;
  };
};

type ChatCompletionResponse = {
  id?: string;
  choices?: ChatCompletionChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: {
    message?: string;
  };
};

export class OpenAIChatCompatibleAdapter implements ProviderAdapter {
  readonly id = "openai-chat-compatible";

  constructor(private readonly config: VesicleConfig) {}

  async complete(request: VesicleRequest): Promise<VesicleResponse> {
    if (!this.config.apiKey) {
      throw new Error("VESICLE_API_KEY is required before making a provider request.");
    }

    const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: request.model.model,
        messages: [
          ...request.system.map((content) => ({ role: "system", content })),
          ...request.messages.map((message) => {
            if (message.role === "tool") {
              return {
                role: "tool",
                tool_call_id: message.toolCallId,
                content: message.content,
              };
            }

            if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
              return {
                role: "assistant",
                content: message.content || null,
                tool_calls: message.toolCalls.map((call) => ({
                  id: call.id,
                  type: "function",
                  function: {
                    name: call.name,
                    arguments: call.arguments,
                  },
                })),
              };
            }

            return {
              role: message.role,
              content: message.content,
            };
          }),
        ],
        tools: request.tools && request.tools.length > 0 ? request.tools : undefined,
        tool_choice: request.tools && request.tools.length > 0 ? "auto" : undefined,
        temperature: request.generation?.temperature ?? 0.7,
        max_tokens: request.generation?.maxTokens,
        stream: false,
      }),
    });

    const body = await response.json().catch(() => undefined) as ChatCompletionResponse | undefined;
    if (!response.ok) {
      const providerMessage = body?.error?.message ?? response.statusText;
      throw new Error(`Provider request failed (${response.status}): ${providerMessage}`);
    }

    const choice = body?.choices?.[0];
    const content = choice?.message?.content ?? "";
    const toolCalls = choice?.message?.tool_calls?.map((toolCall) => ({
      id: toolCall.id,
      name: toolCall.function.name,
      arguments: toolCall.function.arguments,
    }));

    if (!content && (!toolCalls || toolCalls.length === 0)) {
      throw new Error("Provider response did not include assistant content or tool calls.");
    }

    return {
      id: body?.id ?? request.id,
      content,
      toolCalls,
      finishReason: choice?.finish_reason ?? undefined,
      raw: body,
      usage: {
        inputTokens: body?.usage?.prompt_tokens,
        outputTokens: body?.usage?.completion_tokens,
        totalTokens: body?.usage?.total_tokens,
      },
    };
  }
}
