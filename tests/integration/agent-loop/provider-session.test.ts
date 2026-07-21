import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runPrompt } from "../../../src/core/agent-loop/run";
import { loadSessionRecords, } from "../../../src/core/session/store";
import { cleanupProviderConfigDirs, configureTestProviderEnv, createPromptRoot, restoreAgentLoopTestState, } from "./fixtures/agent-loop";

beforeEach(configureTestProviderEnv);
afterEach(restoreAgentLoopTestState);

describe("agent loop: provider session", () => {
  test("reuses one session and sends prior turns to the provider", async () => {
    const rootDir = await createPromptRoot();
    const requestBodies: Array<{ messages: Array<{ role: string; content: string }> }> = [];

    globalThis.fetch = (async (_input: unknown, init: RequestInit & { body?: unknown }) => {
      requestBodies.push(JSON.parse(String(init?.body)));

      return Response.json({
        id: `chatcmpl-${requestBodies.length}`,
        choices: [
          {
            message: {
              content: `reply ${requestBodies.length}`,
            },
          },
        ],
      });
    }) as unknown as typeof fetch;

    const firstMessages = [{ role: "user" as const, content: "first" }];
    const first = await runPrompt({
      input: "first",
      rootDir,
      messages: firstMessages,
    });
    if (first.kind !== "complete") throw new Error("expected complete");
    const firstReply = first.response.content;
    expect(first.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(first.messages.at(-1)?.content).toBe(firstReply);

    const secondMessages = [
      ...first.messages,
      { role: "user" as const, content: "second" },
    ];
    const second = await runPrompt({
      input: "second",
      rootDir,
      sessionId: first.sessionId,
      messages: secondMessages,
    });
    if (second.kind !== "complete") throw new Error("expected complete");

    expect(second.sessionId).toBe(first.sessionId);
    expect(requestBodies[1].messages.map((message) => message.content)).toEqual([
      "base\n\netl",
      "first",
      "reply 1",
      "second",
    ]);

    const jsonl = await readFile(first.sessionPath, "utf8");
    const records = jsonl.trim().split("\n").map((line) => JSON.parse(line));
    expect(records.map((record) => record.role)).toEqual([
      "system",
      "user",
      "system",
      "assistant",
      "user",
      "system",
      "assistant",
    ]);
    expect(records[0].metadata.assets).toMatchObject({
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      files: expect.arrayContaining([
        expect.objectContaining({ path: "assets/engines/etl.profile.yaml" }),
        expect.objectContaining({ path: "assets/prompts/shared/vesicle-base.md" }),
        expect.objectContaining({ path: "assets/prompts/engines/etl.md" }),
      ]),
    });
    expect(records.filter((record) => record.metadata?.kind === "file-history-snapshot")).toHaveLength(2);
  });

  test("injects queued user messages after a complete tool round and before the next provider request", async () => {
    const rootDir = await createPromptRoot();
    await writeFile(join(rootDir, "source_materials", "note.md"), "tool boundary", "utf8");
    const requestBodies: any[] = [];
    let drains = 0;
    const boundaryOrder: string[] = [];
    globalThis.fetch = (async (_input: unknown, init: RequestInit & { body?: unknown }) => {
      const body = JSON.parse(String(init.body));
      requestBodies.push(body);
      if (requestBodies.length === 1) {
        return Response.json({
          id: "queued-boundary-1",
          choices: [{ message: {
            content: "",
            tool_calls: [{
              id: "call-read-before-queue",
              type: "function",
              function: { name: "read_file", arguments: '{"path":"source_materials/note.md"}' },
            }],
          } }],
        });
      }
      return Response.json({ id: "queued-boundary-2", choices: [{ message: { content: "steered" } }] });
    }) as unknown as typeof fetch;

    const result = await runPrompt({
      input: "inspect the note",
      rootDir,
      runToolBoundaryCommands: async () => { boundaryOrder.push("commands"); },
      takePendingUserInputs: () => {
        boundaryOrder.push("messages");
        drains += 1;
        return drains === 1 ? [{ content: "focus only on the tool result" }] : [];
      },
    });

    expect(result.kind).toBe("complete");
    expect(boundaryOrder).toEqual(["commands", "messages"]);
    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[1].messages.slice(-2)).toEqual([
      expect.objectContaining({ role: "tool", tool_call_id: "call-read-before-queue" }),
      expect.objectContaining({ role: "user", content: "focus only on the tool result" }),
    ]);
    const records = await loadSessionRecords(rootDir, result.sessionId);
    expect(records.some((record) => record.role === "user"
      && record.content === "focus only on the tool result"
      && record.metadata?.kind === "queued-user-message")).toBe(true);
    expect(records.filter((record) => record.metadata?.kind === "file-history-snapshot")).toHaveLength(2);
  });

  test("passes configured model generation defaults to the provider request", async () => {
    await cleanupProviderConfigDirs();
    await configureTestProviderEnv({
      models: [
        "      - id: test-model",
        "        generation:",
        "          temperature: 0.2",
        "          maxTokens: 1234",
      ],
    });
    const rootDir = await createPromptRoot();
    const requestBodies: Array<{ temperature?: number; max_tokens?: number }> = [];

    globalThis.fetch = (async (_input: unknown, init: RequestInit & { body?: unknown }) => {
      requestBodies.push(JSON.parse(String(init?.body)));

      return Response.json({
        id: "chatcmpl-generation-defaults",
        choices: [{ message: { content: "reply" } }],
      });
    }) as unknown as typeof fetch;

    const result = await runPrompt({
      input: "use configured defaults",
      rootDir,
    });

    if (result.kind !== "complete") throw new Error("expected complete");
    expect(requestBodies[0]).toMatchObject({
      temperature: 0.2,
      max_tokens: 1234,
    });
  });

  test("does not let undefined generation overrides erase configured defaults", async () => {
    await cleanupProviderConfigDirs();
    await configureTestProviderEnv({
      models: [
        "      - id: test-model",
        "        generation:",
        "          temperature: 0.2",
        "          maxTokens: 1234",
      ],
    });
    const rootDir = await createPromptRoot();
    const requestBodies: Array<{ temperature?: number; max_tokens?: number }> = [];

    globalThis.fetch = (async (_input: unknown, init: RequestInit & { body?: unknown }) => {
      requestBodies.push(JSON.parse(String(init?.body)));

      return Response.json({
        id: "chatcmpl-generation-defined",
        choices: [{ message: { content: "reply" } }],
      });
    }) as unknown as typeof fetch;

    const result = await runPrompt({
      input: "keep configured defaults",
      rootDir,
      generation: { temperature: undefined, maxTokens: undefined },
    });

    if (result.kind !== "complete") throw new Error("expected complete");
    expect(requestBodies[0]).toMatchObject({
      temperature: 0.2,
      max_tokens: 1234,
    });
  });

});
