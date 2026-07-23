import { describe, expect, test } from "bun:test";
import { projectSideQuestionReference } from "../../../src/core/side-question/reference";
import type { SideQuestionContextSnapshot } from "../../../src/core/side-question/types";
import type { VesicleImageAttachment, VesicleMessage } from "../../../src/providers/shared/types";

function snapshot(messages: VesicleMessage[], engineSystemPrompt = "ENGINE PROMPT"): SideQuestionContextSnapshot {
  return {
    sessionId: "side-session",
    engine: "etl",
    providerSelection: { provider: "test", model: "test-model" },
    visionEnabled: false,
    engineSystemPrompt,
    messages,
  };
}

function image(id: string, filename?: string): VesicleImageAttachment {
  return {
    id,
    path: `.vesicle/attachments/${id}.png`,
    mediaType: "image/png",
    bytes: 12,
    sha256: id.repeat(8).slice(0, 64),
    source: "clipboard",
    ...(filename ? { filename } : {}),
  };
}

describe("side question reference projection", () => {
  test("quotes the parent Engine prompt verbatim inside the parent-engine reference block", () => {
    const prompt = "LITERAL ENGINE TEXT\nwith newlines and {{tokens}}";
    const { content } = projectSideQuestionReference(snapshot([], prompt), "q");
    expect(content).toContain(`<parent_engine_reference engine="etl">`);
    expect(content).toContain(`</parent_engine_reference>`);
    expect(content).toContain(`LITERAL ENGINE TEXT\nwith newlines and {{tokens}}`);
  });

  test("places the final question only inside the side-question block", () => {
    const { content } = projectSideQuestionReference(
      snapshot([{ role: "user", content: "earlier user message" }]),
      "what is the Lite prompt?",
    );
    expect(content).toContain("<side_question>\nwhat is the Lite prompt?\n</side_question>");
    // The question does not leak into the conversation or engine reference.
    expect(content.indexOf("what is the Lite prompt?")).toBe(content.lastIndexOf("what is the Lite prompt?"));
  });

  test("preserves user and assistant visible text in source order", () => {
    const { content } = projectSideQuestionReference(
      snapshot([
        { role: "user", content: "first" },
        { role: "assistant", content: "second" },
        { role: "user", content: "third" },
      ]),
      "q",
    );
    const first = content.indexOf("first");
    const second = content.indexOf("second");
    const third = content.indexOf("third");
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);
    expect(content).toContain("[USER]\nfirst");
    expect(content).toContain("[ASSISTANT]\nsecond");
  });

  test("drops structured tool-call protocol but labels the matching tool result by name", () => {
    const { content } = projectSideQuestionReference(
      snapshot([
        { role: "user", content: "do the thing" },
        { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "read_file", arguments: '{"path":"secret/schema.md"}' }] },
        { role: "tool", toolCallId: "call-1", content: "the file contents" },
      ]),
      "q",
    );
    // Tool result kept as a labeled reference fact.
    expect(content).toContain("[TOOL RESULT: read_file]\nthe file contents");
    // Tool-call protocol fields do not survive as text.
    expect(content).not.toContain("call-1");
    expect(content).not.toContain("secret/schema.md");
    expect(content).not.toContain("tool_calls");
  });

  test("strips reasoning, thinking blocks, tool ids, and host kinds", () => {
    const { content } = projectSideQuestionReference(
      snapshot([
        {
          role: "assistant",
          content: "visible answer",
          reasoningContent: "hidden chain of thought",
          thinkingBlocks: [{ type: "reasoning", reasoningContent: "hidden thought" }],
        },
        { role: "user", content: "noted", kind: "quality-rewrite-feedback" },
      ]),
      "q",
    );
    expect(content).not.toContain("hidden chain of thought");
    expect(content).not.toContain("hidden thought");
    expect(content).not.toContain("quality-rewrite-feedback");
    expect(content).toContain("visible answer");
  });

  test("deduplicates repeated image ids into one ordered set with stable markers", () => {
    const { content, images } = projectSideQuestionReference(
      snapshot([
        { role: "user", content: "look", images: [image("img-a", "a.png"), image("img-b", "b.png")] },
        { role: "assistant", content: "ok" },
        { role: "user", content: "again", images: [image("img-a", "a.png")] },
      ]),
      "q",
    );
    expect(images.map((entry) => entry.id)).toEqual(["img-a", "img-b"]);
    expect(images.every((entry) => !("data" in entry && entry.data))).toBe(true);
    // Non-vision snapshot: markers flag that the image is not visible.
    expect(content).toContain("[IMAGE #1: a.png] (not visible to this model)");
    const firstA = content.indexOf("[IMAGE #1: a.png]");
    const firstB = content.indexOf("[IMAGE #2: b.png]");
    const secondA = content.lastIndexOf("[IMAGE #1: a.png]");
    expect(firstA).toBeGreaterThan(-1);
    expect(firstB).toBeGreaterThan(firstA);
    expect(secondA).toBeGreaterThan(firstB);
  });

  test("attaches image markers to the tool result that carried them", () => {
    const context: SideQuestionContextSnapshot = {
      sessionId: "side-session",
      engine: "etl",
      providerSelection: { provider: "test", model: "test-model" },
      visionEnabled: true,
      engineSystemPrompt: "ENGINE PROMPT",
      messages: [
        { role: "user", content: "show me the screenshot" },
        { role: "assistant", content: "", toolCalls: [{ id: "call-img", name: "view_image", arguments: '{"path":"shot.png"}' }] },
        { role: "tool", toolCallId: "call-img", content: "image attached", images: [image("img-shot", "shot.png")] },
      ],
    };
    const { content, images } = projectSideQuestionReference(context, "what is in it?");
    expect(images.map((entry) => entry.id)).toEqual(["img-shot"]);
    const toolBlock = content.indexOf("[TOOL RESULT: view_image]");
    const marker = content.indexOf("[IMAGE #1: shot.png]");
    expect(toolBlock).toBeGreaterThan(-1);
    // The marker follows its tool-result block so the model can tie them together.
    expect(marker).toBeGreaterThan(toolBlock);
    expect(content.indexOf("\n", marker)).toBeGreaterThan(marker);
  });
});
