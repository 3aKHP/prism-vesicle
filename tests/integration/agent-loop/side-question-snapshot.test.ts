import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runPrompt } from "../../../src/core/agent-loop/run";
import type { SideQuestionContextSnapshot } from "../../../src/core/side-question/types";
import { cloneSideQuestionMessages } from "../../../src/core/side-question/types";
import { configureTestProviderEnv, createPromptRoot, restoreAgentLoopTestState } from "./fixtures/agent-loop";

beforeEach(configureTestProviderEnv);
afterEach(restoreAgentLoopTestState);

describe("side question context snapshot boundary", () => {
  test("publishes a complete tool-round boundary before the next provider request", async () => {
    await configureTestProviderEnv();
    const rootDir = await createPromptRoot();
    const snapshots: SideQuestionContextSnapshot[] = [];
    let round = 0;
    globalThis.fetch = (async (_input: unknown, init: RequestInit & { body?: unknown }) => {
      round += 1;
      void init;
      if (round === 1) {
        return Response.json({
          id: "round-1",
          choices: [{ message: {
            content: "",
            tool_calls: [{
              id: "call-read",
              type: "function",
              function: { name: "read_file", arguments: '{"path":"assets/prompts/shared/vesicle-base.md"}' },
            }],
          } }],
        });
      }
      return Response.json({ id: "round-2", choices: [{ message: { content: "done" } }] });
    }) as unknown as typeof fetch;

    const result = await runPrompt({
      input: "read the base prompt",
      rootDir,
      permission: { mode: "MOMENTUM" },
      onProviderContextSnapshot: (snapshot) => snapshots.push(snapshot),
    });
    expect(result.kind).toBe("complete");
    expect(snapshots.length).toBe(2);

    // The snapshot before the second provider request must contain the
    // assistant tool call AND its matching tool result — never a half round.
    const boundary = snapshots[1]!;
    const assistantCall = boundary.messages.find((message) => message.role === "assistant" && message.toolCalls?.length);
    const toolResult = boundary.messages.find((message) => message.role === "tool" && message.toolCallId === "call-read");
    expect(assistantCall?.toolCalls?.[0]?.name).toBe("read_file");
    expect(toolResult).toBeDefined();
    expect(toolResult?.content).toContain("base");

    // Each published snapshot is an independent clone, not the live array.
    expect(snapshots[0]!.messages).not.toBe(snapshots[1]!.messages);
    const beforeMutation = boundary.messages.length;
    boundary.messages.push({ role: "user", content: "tamper" });
    expect(snapshots[1]!.messages.length).toBe(beforeMutation + 1);
    // A fresh clone of the same source is unaffected by the mutation above
    // because cloneSideQuestionMessages always returns a new array.
    const recloned = cloneSideQuestionMessages(snapshots[1]!.messages);
    expect(recloned).not.toBe(snapshots[1]!.messages);
    expect(recloned.length).toBe(beforeMutation + 1);
  });

  test("clone drops base64 image data while keeping references", () => {
    const cloned = cloneSideQuestionMessages([{
      role: "user",
      content: "look",
      images: [{
        id: "img_1",
        path: ".vesicle/attachments/x.png",
        mediaType: "image/png",
        bytes: 12,
        sha256: "abc",
        source: "clipboard",
        data: "base64-bytes",
      }],
      toolCalls: [{ id: "c1", name: "read_file", arguments: "{}" }],
    }]);
    expect(cloned[0]!.images![0]!.data).toBeUndefined();
    expect(cloned[0]!.images![0]!.sha256).toBe("abc");
    expect(cloned[0]!.toolCalls![0]).toEqual({ id: "c1", name: "read_file", arguments: "{}" });
  });
});
