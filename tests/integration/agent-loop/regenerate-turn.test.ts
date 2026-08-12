import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { regenerateTurn, RegenerateBlockedError } from "../../../src/core/agent-loop/regenerate";
import { runPrompt } from "../../../src/core/agent-loop/run";
import { findLatestSelection } from "../../../src/core/session/selection";
import { loadSessionRecords, loadSessionSnapshot } from "../../../src/core/session/store";
import {
  configureTestProviderEnv,
  createPromptRoot,
  restoreAgentLoopTestState,
} from "./fixtures/agent-loop";

beforeEach(configureTestProviderEnv);
afterEach(restoreAgentLoopTestState);

describe("agent loop: regenerate turn", () => {
  test("forks a sibling candidate with a fresh logical turn id, preserves the old candidate, and marks the new one active", async () => {
    const rootDir = await createPromptRoot();
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      const content = calls === 1 ? "candidate-A1" : "candidate-A2";
      return Response.json({ id: `chatcmpl-${calls}`, choices: [{ message: { content } }] });
    }) as unknown as typeof fetch;

    const first = await runPrompt({ input: "the prompt", rootDir, messages: [{ role: "user", content: "the prompt" }] });
    if (first.kind !== "complete") throw new Error(`expected complete, got ${first.kind}`);
    const recordsAfterFirst = await loadSessionRecords(rootDir, first.sessionId);
    const userA = recordsAfterFirst.find((record) => record.role === "user")!;
    const assistantA1 = recordsAfterFirst.filter((record) => record.role === "assistant").at(-1)!;
    const turnA1 = assistantA1.metadata?.logicalTurnId as string;

    const result = await regenerateTurn({ rootDir, sessionId: first.sessionId, userRecordUuid: userA.uuid });
    if (result.kind !== "complete") throw new Error(`expected complete regenerate, got ${result.kind}`);

    const records = await loadSessionRecords(rootDir, first.sessionId);

    // Append-only: the old candidate is still present.
    expect(records.some((record) => record.uuid === assistantA1.uuid)).toBe(true);

    // A fresh sibling candidate subtree was forked off the shared user record.
    const assistantA2 = records
      .filter((record) => record.role === "assistant" && record.uuid !== assistantA1.uuid)
      .at(-1)!;
    expect(assistantA2).toBeDefined();
    expect(assistantA2.content).toBe("candidate-A2");
    const turnA2 = assistantA2.metadata?.logicalTurnId as string;
    expect(turnA2).not.toBe(turnA1);

    // The new candidate is the active branch (default snapshot walks to it).
    const snapshot = await loadSessionSnapshot(rootDir, first.sessionId);
    const activeContents = snapshot.messages.map((message) => message.content).join("\n");
    expect(activeContents).toContain("candidate-A2");
    expect(activeContents).not.toContain("candidate-A1");

    // A selection marker records the new candidate as active.
    const selection = findLatestSelection(records);
    expect(selection?.forkPointUuid).toBe(userA.uuid);

    // The regenerate result's provider context excluded the old candidate.
    const resultContents = result.messages.map((message) => message.content ?? "").join("\n");
    expect(resultContents).not.toContain("candidate-A1");
  });

  test("rejects a target that is not on the current branch", async () => {
    const rootDir = await createPromptRoot();
    globalThis.fetch = (async () => Response.json({ id: "x", choices: [{ message: { content: "ok" } }] })) as unknown as typeof fetch;
    const first = await runPrompt({ input: "the prompt", rootDir, messages: [{ role: "user", content: "the prompt" }] });
    if (first.kind !== "complete") throw new Error("expected complete");

    await expect(
      regenerateTurn({ rootDir, sessionId: first.sessionId, userRecordUuid: "not-on-the-branch" }),
    ).rejects.toBeInstanceOf(RegenerateBlockedError);
  });
});
