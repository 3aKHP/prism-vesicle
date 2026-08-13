import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { regenerateTurn, RegenerateBlockedError } from "../../../src/core/agent-loop/regenerate";
import { runPrompt } from "../../../src/core/agent-loop/run";
import { compactConversation } from "../../../src/core/compact/service";
import { enumerateCandidateLeaves, findLatestSelection } from "../../../src/core/session/selection";
import { createSessionStore, loadSessionRecords, loadSessionSnapshot } from "../../../src/core/session/store";
import {
  configureTestProviderEnv,
  createPromptRoot,
  restoreAgentLoopTestState,
} from "./fixtures/agent-loop";

beforeEach(configureTestProviderEnv);
afterEach(restoreAgentLoopTestState);

describe("agent loop: regenerate turn", () => {
  test("forks a sibling candidate in the shared logical turn, preserves the old candidate, and marks the new one active", async () => {
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
    expect(turnA2).toBe(turnA1);

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

  test("keeps the regenerated prompt and selected response together through compaction", async () => {
    const rootDir = await createPromptRoot();
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      const content = calls === 1
        ? "earlier-response"
        : calls === 2
          ? "candidate-A1"
          : calls === 3
            ? "candidate-A2"
            : "<summary>Earlier context.</summary>";
      return Response.json({ id: `chatcmpl-${calls}`, choices: [{ message: { content } }] });
    }) as unknown as typeof fetch;

    const earlier = await runPrompt({ input: "earlier prompt", rootDir, messages: [{ role: "user", content: "earlier prompt" }] });
    if (earlier.kind !== "complete") throw new Error(`expected complete, got ${earlier.kind}`);
    const target = await runPrompt({
      input: "the prompt",
      rootDir,
      sessionId: earlier.sessionId,
      messages: [...earlier.messages, { role: "user", content: "the prompt" }],
    });
    if (target.kind !== "complete") throw new Error(`expected complete, got ${target.kind}`);
    const targetUser = (await loadSessionRecords(rootDir, earlier.sessionId))
      .filter((record) => record.role === "user")
      .at(-1)!;

    const regenerated = await regenerateTurn({ rootDir, sessionId: earlier.sessionId, userRecordUuid: targetUser.uuid });
    if (regenerated.kind !== "complete") throw new Error(`expected complete regenerate, got ${regenerated.kind}`);
    const compacted = await compactConversation({ rootDir, sessionId: earlier.sessionId, engine: "etl" });

    expect(compacted.snapshot.messages.slice(-2).map((message) => [message.role, message.content])).toEqual([
      ["user", "the prompt"],
      ["assistant", "candidate-A2"],
    ]);
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

  test("a failed regenerate round restores the previous candidate as the active branch", async () => {
    const rootDir = await createPromptRoot();
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) return Response.json({ id: "c1", choices: [{ message: { content: "candidate-A1" } }] });
      // The regenerate provider round fails.
      throw new Error("provider down");
    }) as unknown as typeof fetch;

    const first = await runPrompt({ input: "the prompt", rootDir, messages: [{ role: "user", content: "the prompt" }] });
    if (first.kind !== "complete") throw new Error(`expected complete, got ${first.kind}`);
    const recordsAfterFirst = await loadSessionRecords(rootDir, first.sessionId);
    const userA = recordsAfterFirst.find((record) => record.role === "user")!;

    // bootstrap appended the new candidate's file-history snapshot before the
    // failed provider round; without a restore marker the default head would be
    // stuck on that incomplete snapshot. The catch must re-arm the old candidate.
    await expect(
      regenerateTurn({ rootDir, sessionId: first.sessionId, userRecordUuid: userA.uuid }),
    ).rejects.toThrow("provider down");

    const records = await loadSessionRecords(rootDir, first.sessionId);
    const snapshot = await loadSessionSnapshot(rootDir, first.sessionId);
    // The old candidate is still the active branch (visible in projection)...
    const contents = snapshot.messages.map((message) => message.content).join("\n");
    expect(contents).toContain("candidate-A1");
    // ...because a restore selection marker was appended for the fork point.
    expect(findLatestSelection(records)?.forkPointUuid).toBe(userA.uuid);
  });

  test("rejects regenerate while an interaction is pending at the core boundary", async () => {
    const rootDir = await createPromptRoot();
    const store = await createSessionStore(rootDir, "pending-regenerate");
    await store.append({ role: "system", content: "prompt", metadata: { engine: "etl" } });
    const user = await store.append({ role: "user", content: "prompt" });
    await store.append({
      role: "assistant",
      content: "confirm",
      metadata: { toolCalls: [{ id: "gate", name: "request_confirmation", arguments: JSON.stringify({ gate: "runtime-turn", summary: "confirm" }) }] },
    });
    await expect(regenerateTurn({ rootDir, sessionId: "pending-regenerate", userRecordUuid: user.uuid })).rejects.toThrow(/pending interaction/);
  });

  test("failed regenerate restores the candidate content leaf after later host records", async () => {
    const rootDir = await createPromptRoot();
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls < 3) return Response.json({ id: `c${calls}`, choices: [{ message: { content: `candidate-A${calls}` } }] });
      throw new Error("provider down");
    }) as unknown as typeof fetch;
    const first = await runPrompt({ input: "the prompt", rootDir, messages: [{ role: "user", content: "the prompt" }] });
    if (first.kind !== "complete") throw new Error(`expected complete, got ${first.kind}`);
    const initialRecords = await loadSessionRecords(rootDir, first.sessionId);
    const user = initialRecords.find((record) => record.role === "user")!;
    await regenerateTurn({ rootDir, sessionId: first.sessionId, userRecordUuid: user.uuid });
    const host = await createSessionStore(rootDir, first.sessionId);
    await host.append({ role: "system", content: "switched", metadata: { kind: "provider-switch", providerId: "p2", model: "m2" } });

    await expect(regenerateTurn({ rootDir, sessionId: first.sessionId, userRecordUuid: user.uuid })).rejects.toThrow("provider down");
    const records = await loadSessionRecords(rootDir, first.sessionId);
    const selection = findLatestSelection(records)!;
    const leaves = enumerateCandidateLeaves(records, user.uuid).map((record) => record.uuid);
    expect(leaves).toContain(selection.selectedLeafUuid);
  });
});
