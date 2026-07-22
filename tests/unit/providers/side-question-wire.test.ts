import { describe, expect, test } from "bun:test";
import { toAnthropicMessagesBody } from "../../../src/providers/anthropic-messages/request";
import { toChatCompletionBody } from "../../../src/providers/openai-chat/request";
import { toGeminiGenerateContentBody } from "../../../src/providers/gemini-generate-content/request";
import { projectSideQuestionReference } from "../../../src/core/side-question/reference";
import type { SideQuestionContextSnapshot } from "../../../src/core/side-question/types";
import type { VesicleRequest } from "../../../src/providers/shared/types";

const SIDE_PROMPT = "SIDE PROMPT — sole system authority";

function buildSideRequest(): VesicleRequest {
  const context: SideQuestionContextSnapshot = {
    sessionId: "side-session",
    engine: "etl",
    providerSelection: { provider: "test", model: "test-model" },
    visionEnabled: false,
    engineSystemPrompt: "ENGINE PROMPT (parent authority)",
    messages: [
      { role: "user", content: "do thing" },
      { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "read_file", arguments: '{"path":"x"}' }] },
      { role: "tool", toolCallId: "call-1", content: "file body" },
    ],
  };
  const projection = projectSideQuestionReference(context, "what is the engine doing?");
  return {
    id: "side-session:btw:test",
    model: { provider: "test", model: "test-model" },
    system: [SIDE_PROMPT],
    messages: [{ role: "user", content: projection.content }],
  };
}

describe("side question wire shape across protocols", () => {
  const request = buildSideRequest();

  test("OpenAI chat: one system (side prompt), one user packet, no tools, no tool protocol", () => {
    const body = toChatCompletionBody(request, false);
    const messages = body.messages as Array<{ role: string; content?: unknown }>;
    const systems = messages.filter((message) => message.role === "system");
    expect(systems).toHaveLength(1);
    expect(systems[0]!.content).toBe(SIDE_PROMPT);
    expect(messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(messages.filter((message) => message.role === "tool")).toHaveLength(0);
    expect(messages.filter((message) => message.role === "assistant")).toHaveLength(0);
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
    // The parent Engine prompt and tool result survive as quoted reference text.
    const packet = String(messages.find((message) => message.role === "user")!.content);
    expect(packet).toContain("ENGINE PROMPT (parent authority)");
    expect(packet).toContain("[TOOL RESULT: read_file]");
    expect(packet).toContain("what is the engine doing?");
  });

  test("Anthropic messages: one system string (side prompt), one user turn, no tools", () => {
    const body = toAnthropicMessagesBody(request);
    expect(body.system).toBe(SIDE_PROMPT);
    const messages = body.messages as Array<{ role: string; content: unknown }>;
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe("user");
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
    expect(JSON.stringify(messages[0]!.content)).toContain("ENGINE PROMPT (parent authority)");
  });

  test("Gemini generateContent: one systemInstruction (side prompt), one content, no tools", () => {
    const body = toGeminiGenerateContentBody(request);
    const systemParts = (body.systemInstruction as { parts: Array<{ text?: string }> }).parts;
    expect(systemParts).toHaveLength(1);
    expect(systemParts[0]!.text).toBe(SIDE_PROMPT);
    const contents = body.contents as Array<{ role: string; parts: unknown }>;
    expect(contents).toHaveLength(1);
    expect(contents[0]!.role).toBe("user");
    expect(body.tools).toBeUndefined();
    expect(JSON.stringify(contents[0]!.parts)).toContain("ENGINE PROMPT (parent authority)");
  });
});
