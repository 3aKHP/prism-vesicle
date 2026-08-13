import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { regenerateTurn, RegenerateBlockedError } from "../../../src/core/agent-loop/regenerate";
import { runPrompt } from "../../../src/core/agent-loop/run";
import { compactConversation } from "../../../src/core/compact/service";
import { appendCandidateSelection, enumerateCandidateLeaves, findLatestSelection } from "../../../src/core/session/selection";
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

  test("selects the assistant leaf when finalization appends validation host metadata", async () => {
    const rootDir = await createPromptRoot({ validators: ["runtime-packet"] });
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return Response.json({
        id: `chatcmpl-${calls}`,
        choices: [{ message: { content: `[Beat] candidate-${calls}` } }],
      });
    }) as unknown as typeof fetch;

    const first = await runPrompt({ input: "the prompt", rootDir, messages: [{ role: "user", content: "the prompt" }] });
    if (first.kind !== "complete") throw new Error(`expected complete, got ${first.kind}`);
    const user = (await loadSessionRecords(rootDir, first.sessionId)).find((record) => record.role === "user")!;
    const regenerated = await regenerateTurn({ rootDir, sessionId: first.sessionId, userRecordUuid: user.uuid });
    if (regenerated.kind !== "complete") throw new Error(`expected complete regenerate, got ${regenerated.kind}`);

    const records = await loadSessionRecords(rootDir, first.sessionId);
    const selection = findLatestSelection(records)!;
    const selected = records.find((record) => record.uuid === selection.selectedLeafUuid)!;
    expect(selected.role).toBe("assistant");
    expect(records.find((record) => record.metadata?.kind === "validation")).toBeDefined();
    expect(enumerateCandidateLeaves(records, user.uuid).every((record) => record.role !== "system")).toBe(true);
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

  test("restores the fork baseline and bundles the old candidate before the new candidate runs", async () => {
    const rootDir = await createPromptRoot();
    await writeFile(join(rootDir, "workspace", "existing.md"), "before\n", "utf8");
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) {
        return Response.json({
          id: "c1",
          choices: [{
            message: {
              content: "",
              tool_calls: [{
                id: "call-write",
                type: "function",
                function: { name: "write_file", arguments: JSON.stringify({ path: "workspace/existing.md", content: "A version\n" }) },
              }],
            },
          }],
        });
      }
      return Response.json({ id: `c${calls}`, choices: [{ message: { content: `candidate-A${calls}` } }] });
    }) as unknown as typeof fetch;

    // Candidate A1's turn performs a real file write through the guarded tool.
    const first = await runPrompt({ input: "the prompt", rootDir, messages: [{ role: "user", content: "the prompt" }] });
    if (first.kind !== "complete") throw new Error(`expected complete, got ${first.kind}`);
    expect(await readFile(join(rootDir, "workspace", "existing.md"), "utf8")).toBe("A version\n");
    const recordsAfterFirst = await loadSessionRecords(rootDir, first.sessionId);
    const userA = recordsAfterFirst.find((record) => record.role === "user")!;
    const assistantA1 = enumerateCandidateLeaves(recordsAfterFirst, userA.uuid)[0]!;

    const result = await regenerateTurn({ rootDir, sessionId: first.sessionId, userRecordUuid: userA.uuid });
    if (result.kind !== "complete") throw new Error(`expected complete regenerate, got ${result.kind}`);

    // The new candidate ran against the restored baseline (it performs no file
    // writes itself, so the disk stays at the baseline).
    expect(await readFile(join(rootDir, "workspace", "existing.md"), "utf8")).toBe("before\n");
    // The old candidate's post-state was bundled for later switching.
    const records = await loadSessionRecords(rootDir, first.sessionId);
    const bundle = records.find((record) => record.metadata?.kind === "candidate-file-state");
    expect(bundle?.metadata?.leafUuid).toBe(assistantA1.uuid);
  });

  test("a failed regenerate restores the old candidate's bundled files as well as its marker", async () => {
    const rootDir = await createPromptRoot();
    await writeFile(join(rootDir, "workspace", "existing.md"), "before\n", "utf8");
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) {
        return Response.json({
          id: "c1",
          choices: [{
            message: {
              content: "",
              tool_calls: [{
                id: "call-write",
                type: "function",
                function: { name: "write_file", arguments: JSON.stringify({ path: "workspace/existing.md", content: "A version\n" }) },
              }],
            },
          }],
        });
      }
      if (calls === 2) {
        return Response.json({ id: "c2", choices: [{ message: { content: "candidate-A1" } }] });
      }
      // The regenerate provider round fails.
      throw new Error("provider down");
    }) as unknown as typeof fetch;

    const first = await runPrompt({ input: "the prompt", rootDir, messages: [{ role: "user", content: "the prompt" }] });
    if (first.kind !== "complete") throw new Error(`expected complete, got ${first.kind}`);
    const userA = (await loadSessionRecords(rootDir, first.sessionId)).find((record) => record.role === "user")!;

    await expect(regenerateTurn({ rootDir, sessionId: first.sessionId, userRecordUuid: userA.uuid }))
      .rejects.toThrow("provider down");

    // Conversation compensation (existing) and file compensation (new): the old
    // candidate is active again AND the disk is back at its post-state, not at
    // the baseline the failed regenerate had restored.
    const selection = findLatestSelection(await loadSessionRecords(rootDir, first.sessionId));
    expect(selection?.forkPointUuid).toBe(userA.uuid);
    expect(await readFile(join(rootDir, "workspace", "existing.md"), "utf8")).toBe("A version\n");
  });

  test("a failed regenerate that wrote files bundles the partial candidate and restores the old candidate", async () => {
    const rootDir = await createPromptRoot();
    await writeFile(join(rootDir, "workspace", "existing.md"), "before\n", "utf8");
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) {
        return Response.json({
          id: "c1",
          choices: [{
            message: {
              content: "",
              tool_calls: [{
                id: "call-a-write",
                type: "function",
                function: { name: "write_file", arguments: JSON.stringify({ path: "workspace/existing.md", content: "A version\n" }) },
              }],
            },
          }],
        });
      }
      if (calls === 2) {
        return Response.json({ id: "c2", choices: [{ message: { content: "candidate-A1" } }] });
      }
      if (calls === 3) {
        // The failed candidate writes before its second provider round fails.
        return Response.json({
          id: "c3",
          choices: [{
            message: {
              content: "",
              tool_calls: [
                {
                  id: "call-c-write",
                  type: "function",
                  function: { name: "write_file", arguments: JSON.stringify({ path: "workspace/existing.md", content: "C partial\n" }) },
                },
                {
                  id: "call-c-create",
                  type: "function",
                  function: { name: "write_file", arguments: JSON.stringify({ path: "workspace/partial.md", content: "partial body\n" }) },
                },
              ],
            },
          }],
        });
      }
      throw new Error("provider down");
    }) as unknown as typeof fetch;

    const first = await runPrompt({ input: "the prompt", rootDir, messages: [{ role: "user", content: "the prompt" }] });
    if (first.kind !== "complete") throw new Error(`expected complete, got ${first.kind}`);
    const recordsAfterFirst = await loadSessionRecords(rootDir, first.sessionId);
    const userA = recordsAfterFirst.find((record) => record.role === "user")!;
    const assistantA1 = enumerateCandidateLeaves(recordsAfterFirst, userA.uuid)[0]!;

    await expect(regenerateTurn({ rootDir, sessionId: first.sessionId, userRecordUuid: userA.uuid }))
      .rejects.toThrow("provider down");

    // The old candidate regains its files; the failed candidate's creation is
    // deleted, and its partial post-state survives as a switchable bundle.
    expect(await readFile(join(rootDir, "workspace", "existing.md"), "utf8")).toBe("A version\n");
    await expect(stat(join(rootDir, "workspace", "partial.md"))).rejects.toMatchObject({ code: "ENOENT" });
    const records = await loadSessionRecords(rootDir, first.sessionId);
    const selection = findLatestSelection(records);
    expect(selection?.selectedLeafUuid).toBe(assistantA1.uuid);
    const bundles = records.filter((record) => record.metadata?.kind === "candidate-file-state");
    expect(bundles.map((record) => record.metadata?.leafUuid).sort())
      .toEqual([assistantA1.uuid, enumerateCandidateLeaves(records, userA.uuid).map((record) => record.uuid).filter((leaf) => leaf !== assistantA1.uuid)[0]].sort());
    const failedBundle = bundles.find((record) => record.metadata?.leafUuid !== assistantA1.uuid);
    expect(Object.keys(failedBundle?.metadata?.files as Record<string, unknown>)).toContain("workspace/partial.md");
  });

  test("regenerating over a bundle-less candidate never moves the disk", async () => {
    const rootDir = await createPromptRoot();
    await writeFile(join(rootDir, "workspace", "existing.md"), "before\n", "utf8");
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) {
        return Response.json({
          id: "c1",
          choices: [{
            message: {
              content: "",
              tool_calls: [{
                id: "call-write",
                type: "function",
                function: { name: "write_file", arguments: JSON.stringify({ path: "workspace/existing.md", content: "A version\n" }) },
              }],
            },
          }],
        });
      }
      if (calls === 2) {
        return Response.json({ id: "c2", choices: [{ message: { content: "candidate-A1" } }] });
      }
      throw new Error("provider down");
    }) as unknown as typeof fetch;

    const first = await runPrompt({ input: "the prompt", rootDir, messages: [{ role: "user", content: "the prompt" }] });
    if (first.kind !== "complete") throw new Error(`expected complete, got ${first.kind}`);
    const recordsAfterFirst = await loadSessionRecords(rootDir, first.sessionId);
    const userA = recordsAfterFirst.find((record) => record.role === "user")!;

    // A bundle-less sibling candidate selected conversation-only: the marker
    // points at it while the disk still holds A1's files (the documented
    // degradation). No bundle is ever captured for it, so regenerate must skip
    // the baseline restore entirely — a failed regenerate cannot strand the
    // disk away from the state it started from.
    const forked = await createSessionStore(rootDir, first.sessionId, { parentUuid: userA.uuid });
    const bareCandidate = await forked.append({ role: "assistant", content: "bare candidate", metadata: { logicalTurnId: "t1", providerRoundId: "r9" } });
    await appendCandidateSelection(rootDir, first.sessionId, { forkPointUuid: userA.uuid, selectedLeafUuid: bareCandidate.uuid });

    await expect(regenerateTurn({ rootDir, sessionId: first.sessionId, userRecordUuid: userA.uuid }))
      .rejects.toThrow("provider down");

    expect(await readFile(join(rootDir, "workspace", "existing.md"), "utf8")).toBe("A version\n");
    const records = await loadSessionRecords(rootDir, first.sessionId);
    expect(records.some((record) => record.metadata?.kind === "candidate-file-state")).toBe(false);
    expect(findLatestSelection(records)?.selectedLeafUuid).toBe(bareCandidate.uuid);
  });
});
