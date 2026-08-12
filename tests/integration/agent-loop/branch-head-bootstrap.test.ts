import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runPrompt } from "../../../src/core/agent-loop/run";
import { loadSessionRecords } from "../../../src/core/session/store";
import {
  configureTestProviderEnv,
  createPromptRoot,
  restoreAgentLoopTestState,
} from "./fixtures/agent-loop";

beforeEach(configureTestProviderEnv);
afterEach(restoreAgentLoopTestState);

// Phase 0 gate for #88 (regenerate precursor). A branched runPrompt — the exact
// option combination regenerateTurn will use (sessionParentUuid forks the append
// chain off the shared user record; branchHeadUuid scopes the bootstrap snapshot
// to the fork-point branch; prePersistedInputUuid reuses the user record without
// re-appending; messages supplies the fresh-context provider list) — must append
// a SIBLING candidate subtree with a fresh logical turn id, preserve the old
// candidate (append-only), and send the provider a fresh context that excludes
// the old candidate's assistant reply.
describe("agent loop: branched turn (regenerate precursor)", () => {
  test("forks a sibling candidate subtree off the shared user record with a fresh logical turn id", async () => {
    const rootDir = await createPromptRoot();
    const requests: Array<{ messages: Array<{ role: string; content?: string }> }> = [];
    let calls = 0;
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      calls += 1;
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content?: string }> };
      requests.push(body);
      // Candidate A1 (first turn) and candidate A2 (regenerate) differ so the
      // fresh-context exclusion is observable in the persisted records.
      const content = calls === 1 ? "candidate-A1" : "candidate-A2";
      return Response.json({ id: `chatcmpl-${calls}`, choices: [{ message: { content } }] });
    }) as typeof fetch;

    // First turn: system -> user-A -> assistant-A1.
    const first = await runPrompt({ input: "the prompt", rootDir, messages: [{ role: "user", content: "the prompt" }] });
    if (first.kind !== "complete") throw new Error(`expected complete, got ${first.kind}`);

    const recordsAfterFirst = await loadSessionRecords(rootDir, first.sessionId);
    const userA = recordsAfterFirst.find((record) => record.role === "user")!;
    const assistantA1 = recordsAfterFirst.filter((record) => record.role === "assistant").at(-1)!;
    const turnA1 = assistantA1.metadata?.logicalTurnId as string | undefined;
    expect(typeof turnA1).toBe("string");

    // Regenerate: fork off the shared user record, reuse it, scope the snapshot
    // to the fork-point branch, and supply the fresh-context provider messages.
    const second = await runPrompt({
      input: userA.content,
      rootDir,
      sessionId: first.sessionId,
      sessionParentUuid: userA.uuid,
      branchHeadUuid: userA.uuid,
      prePersistedInputUuid: userA.uuid,
      messages: [{ role: "user", content: userA.content }],
    });
    if (second.kind !== "complete") throw new Error(`expected complete regenerate, got ${second.kind}`);

    const records = await loadSessionRecords(rootDir, first.sessionId);

    // Append-only: the old candidate's records are still present.
    expect(records.some((record) => record.uuid === assistantA1.uuid)).toBe(true);

    // The shared user record now has two candidate subtrees hanging off it
    // (each begins with its own file-history snapshot, then the assistant leaf).
    const candidateRoots = records.filter((record) => record.parentUuid === userA.uuid);
    expect(candidateRoots.length).toBe(2);

    // The new candidate's assistant leaf carries a fresh logical turn id.
    const assistantA2 = records
      .filter((record) => record.role === "assistant" && record.uuid !== assistantA1.uuid)
      .at(-1)!;
    expect(assistantA2).toBeDefined();
    expect(assistantA2.content).toBe("candidate-A2");
    const turnA2 = assistantA2.metadata?.logicalTurnId as string | undefined;
    expect(typeof turnA2).toBe("string");
    expect(turnA2).not.toBe(turnA1);

    // Fresh-context exclusion: the regenerate provider request ended at the user
    // record and never included the old candidate's assistant reply.
    const regenerateRequest = requests.at(-1)!;
    const regenerateContext = regenerateRequest.messages.map((message) => message.content ?? "").join("\n");
    expect(regenerateContext).not.toContain("candidate-A1");
  });
});
