import { readFile, } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resolveUserQuestion, runPrompt } from "../../../src/core/agent-loop/run";
import { configureTestProviderEnv, createPromptRoot, restoreAgentLoopTestState, } from "./fixtures/agent-loop";

beforeEach(configureTestProviderEnv);
afterEach(restoreAgentLoopTestState);

describe("agent loop: question continuation", () => {
  test("surfaces ask_user_question as a user question pause", async () => {
    const rootDir = await createPromptRoot();

    globalThis.fetch = (async () => {
      return Response.json({
        id: "chatcmpl-question",
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              content: "I need one choice before continuing.",
              tool_calls: [
                {
                  id: "call-question",
                  type: "function",
                  function: {
                    name: "ask_user_question",
                    arguments: JSON.stringify({
                      header: "Scope",
                      question: "Which scope should I use?",
                      options: [
                        { label: "Narrow", description: "Only change the minimum needed." },
                        { label: "Broad", description: "Include adjacent cleanup." },
                      ],
                    }),
                  },
                },
              ],
            },
          },
        ],
      });
    }) as unknown as typeof fetch;

    const result = await runPrompt({
      input: "continue workflow",
      rootDir,
      messages: [{ role: "user", content: "continue workflow" }],
    });

    expect(result.kind).toBe("needs_user_question");
    if (result.kind !== "needs_user_question") throw new Error("expected needs_user_question");
    expect(result.question.header).toBe("Scope");
    expect(result.question.options.map((option) => option.label)).toEqual(["Narrow", "Broad", "Skip", "Answer freely"]);
    expect(result.question.options[2].kind).toBe("skip");
    expect(result.question.options[3].kind).toBe("freeform");
  });

  test("resolveUserQuestion continues the engine loop with the selected answer", async () => {
    const rootDir = await createPromptRoot();
    let callCount = 0;
    const seenBodies: Array<{ messages: Array<{ role: string; content: string }> }> = [];

    globalThis.fetch = (async (_input: unknown, init: RequestInit & { body?: unknown }) => {
      callCount += 1;
      seenBodies.push(JSON.parse(String(init?.body)));
      if (callCount === 1) {
        return Response.json({
          id: "chatcmpl-question",
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                content: "Pick a scope.",
                tool_calls: [
                  {
                    id: "call-question",
                    type: "function",
                    function: {
                      name: "ask_user_question",
                      arguments: JSON.stringify({
                        header: "Scope",
                        question: "Which scope should I use?",
                        options: [
                          { label: "Narrow", description: "Only change the minimum needed." },
                          { label: "Broad", description: "Include adjacent cleanup." },
                        ],
                      }),
                    },
                  },
                ],
              },
            },
          ],
        });
      }
      return Response.json({
        id: "chatcmpl-answer",
        choices: [{ message: { content: "Continuing narrowly." } }],
      });
    }) as unknown as typeof fetch;

    const paused = await runPrompt({
      input: "continue workflow",
      rootDir,
      messages: [{ role: "user", content: "continue workflow" }],
    });
    if (paused.kind !== "needs_user_question") throw new Error("expected needs_user_question");

    const resumed = await resolveUserQuestion({
      engine: "etl",
      rootDir,
      sessionId: paused.sessionId,
      messages: paused.messages,
      toolCallId: paused.toolCallId,
      question: paused.question,
      answer: { selectedIndex: 0, label: "Narrow", description: "Only change the minimum needed." },
    });

    expect(resumed.kind).toBe("complete");
    if (resumed.kind !== "complete") throw new Error("expected complete");
    expect(resumed.response.content).toBe("Continuing narrowly.");
    expect(seenBodies[1].messages.some((m) => m.role === "tool" && m.content.includes("Narrow"))).toBe(true);
    expect(seenBodies[1].messages.some((m) => m.role === "user" && m.content.includes("[question:Scope answered]"))).toBe(true);
  });

  test("resolveUserQuestion threads free-form fallback answers", async () => {
    const rootDir = await createPromptRoot();
    let callCount = 0;
    const seenBodies: Array<{ messages: Array<{ role: string; content: string }> }> = [];

    globalThis.fetch = (async (_input: unknown, init: RequestInit & { body?: unknown }) => {
      callCount += 1;
      seenBodies.push(JSON.parse(String(init?.body)));
      if (callCount === 1) {
        return Response.json({
          id: "chatcmpl-question",
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                content: "Pick a scope.",
                tool_calls: [
                  {
                    id: "call-question",
                    type: "function",
                    function: {
                      name: "ask_user_question",
                      arguments: JSON.stringify({
                        header: "Scope",
                        question: "Which scope should I use?",
                        options: [
                          { label: "Narrow", description: "Only change the minimum needed." },
                          { label: "Broad", description: "Include adjacent cleanup." },
                        ],
                      }),
                    },
                  },
                ],
              },
            },
          ],
        });
      }
      return Response.json({
        id: "chatcmpl-answer",
        choices: [{ message: { content: "Continuing." } }],
      });
    }) as unknown as typeof fetch;

    const paused = await runPrompt({
      input: "continue workflow",
      rootDir,
      messages: [{ role: "user", content: "continue workflow" }],
    });
    if (paused.kind !== "needs_user_question") throw new Error("expected needs_user_question");

    await resolveUserQuestion({
      engine: "etl",
      rootDir,
      sessionId: paused.sessionId,
      messages: paused.messages,
      toolCallId: paused.toolCallId,
      question: paused.question,
      answer: { selectedIndex: 3, label: "Answer freely", description: "Type freely.", kind: "freeform", freeformText: "Keep the file format unchanged." },
    });

    expect(seenBodies[1].messages.some((m) => m.role === "tool" && m.content.includes("freeformText"))).toBe(true);
    expect(seenBodies[1].messages.some((m) => m.role === "user" && m.content.includes("[question:Scope answered freely] Keep the file format unchanged."))).toBe(true);

    const jsonl = await readFile(paused.sessionPath, "utf8");
    expect(jsonl).toContain('"answerKind":"freeform"');
    expect(jsonl).toContain("Keep the file format unchanged.");
  });

});
