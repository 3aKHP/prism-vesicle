import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runPrompt } from "../../../src/core/agent-loop/run";
import { createSessionStore, loadSessionRecords, recoverActiveIdentity, segmentSession } from "../../../src/core/session/store";
import {
  configureTestProviderEnv,
  createPromptRoot,
  restoreAgentLoopTestState,
} from "./fixtures/agent-loop";

beforeEach(configureTestProviderEnv);
afterEach(restoreAgentLoopTestState);

describe("agent loop: execution identity", () => {
  test("a tool-loop turn persists one logical turn id and advancing provider round ids", async () => {
    const rootDir = await createPromptRoot();
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) {
        return Response.json({
          id: `chatcmpl-${calls}`,
          choices: [{
            message: {
              content: "",
              tool_calls: [{
                id: "call-write",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({ path: "workspace/note.md", content: "x" }),
                },
              }],
            },
          }],
        });
      }
      return Response.json({
        id: `chatcmpl-${calls}`,
        choices: [{ message: { content: "done" } }],
      });
    }) as unknown as typeof fetch;

    const result = await runPrompt({ input: "write a note", rootDir, messages: [{ role: "user", content: "write a note" }] });
    if (result.kind !== "complete") throw new Error("expected complete turn");

    const records = await loadSessionRecords(rootDir, result.sessionId);
    const conversational = records.filter((record) => record.role !== "system");
    // The bootstrap system record is the session root and must not carry a turn id.
    expect(records[0]!.role).toBe("system");
    expect(records[0]!.metadata?.logicalTurnId).toBeUndefined();

    const turnIds = new Set(conversational.map((record) => record.metadata?.logicalTurnId as string | undefined));
    expect(turnIds.size).toBe(1);
    const logicalTurnId = conversational[0]!.metadata?.logicalTurnId as string | undefined;
    expect(typeof logicalTurnId).toBe("string");

    // The user input, the tool-calling assistant, and its tool result share the
    // first provider round; the final assistant reply is the next provider round.
    const roundId = (record: { metadata?: Record<string, unknown> }) => record.metadata?.providerRoundId as string | undefined;
    const userRecord = records.find((record) => record.role === "user")!;
    const toolCallAssistant = records.find((record) => record.role === "assistant" && (record.metadata?.toolCalls as unknown[] | undefined)?.length);
    const toolRecord = records.find((record) => record.role === "tool")!;
    const finalAssistant = records.filter((record) => record.role === "assistant").at(-1)!;

    expect(roundId(userRecord)).toBeDefined();
    expect(roundId(toolCallAssistant!)).toBe(roundId(userRecord));
    expect(roundId(toolRecord)).toBe(roundId(userRecord));
    expect(roundId(finalAssistant)).toBeDefined();
    expect(roundId(finalAssistant)).not.toBe(roundId(userRecord));

    // Recovery sees the newest persisted round, so a resumed pause re-binds it.
    const recovered = recoverActiveIdentity(records);
    expect(recovered?.logicalTurnId).toBe(logicalTurnId);
    expect(recovered?.providerRoundId).toBe(roundId(finalAssistant));

    // Segmentation groups the turn into the two provider rounds above.
    const segmentation = segmentSession(records);
    expect(segmentation.turns).toHaveLength(1);
    const turn = segmentation.turns[0]!;
    expect(turn.logicalTurnId).toBe(logicalTurnId);
    expect(turn.complete).toBe(true);
    expect(turn.rounds).toHaveLength(2);
    const roundRoles = (round: { records: { role: string }[] }) => round.records.filter((record) => record.role !== "system").map((record) => record.role);
    expect(roundRoles(turn.rounds[0]!)).toEqual(["user", "assistant", "tool"]);
    expect(roundRoles(turn.rounds[1]!)).toEqual(["assistant"]);
  });

  test("a resumed pause keeps the original logical turn across continuation rounds", async () => {
    const rootDir = await createPromptRoot({ stopGates: ["blueprint-confirmation"] });
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      // First round: the assistant asks for blueprint confirmation (a gate).
      if (calls === 1) {
        return Response.json({
          id: `chatcmpl-${calls}`,
          choices: [{
            message: {
              content: "here is the blueprint",
              tool_calls: [{
                id: "call-gate",
                type: "function",
                function: {
                  name: "request_confirmation",
                  arguments: JSON.stringify({ gate: "blueprint-confirmation", summary: "Concept: A" }),
                },
              }],
            },
          }],
        });
      }
      // After the gate is resolved the continuation runs a new provider round.
      return Response.json({ id: `chatcmpl-${calls}`, choices: [{ message: { content: "advancing" } }] });
    }) as unknown as typeof fetch;

    const first = await runPrompt({ input: "draft a blueprint", rootDir, messages: [{ role: "user", content: "draft a blueprint" }] });
    if (first.kind !== "needs_user") throw new Error("expected a pending gate");

    const gateCallAssistant = (await loadSessionRecords(rootDir, first.sessionId)).find((record) => record.role === "assistant")!;
    const gateRoundId = gateCallAssistant.metadata?.providerRoundId as string | undefined;
    const logicalTurnId = gateCallAssistant.metadata?.logicalTurnId as string | undefined;

    const { resolveGate } = await import("../../../src/core/agent-loop/gate-continuation");
    const resolved = await resolveGate({
      engine: "etl",
      rootDir,
      sessionId: first.sessionId,
      gate: first.gate,
      toolCallId: first.toolCallId,
      resolution: { decision: "confirm" },
      messages: first.messages,
    });
    if (resolved.kind !== "complete") throw new Error("expected complete after gate resolution");

    const records = await loadSessionRecords(rootDir, first.sessionId);
    const gateResolution = records.find((record) => record.metadata?.kind === "gate-resolution" && record.role === "tool")!;
    // The gate resolution belongs to the same provider round as the gate call;
    // resuming the pause never creates a new logical turn.
    expect(gateResolution.metadata?.providerRoundId as string | undefined).toBe(gateRoundId);
    expect(gateResolution.metadata?.logicalTurnId as string | undefined).toBe(logicalTurnId);

    // Every record this logical turn produced shares the same logical turn id.
    const turnRecords = records.filter((record) => (record.metadata?.logicalTurnId as string | undefined) === logicalTurnId);
    expect(turnRecords.length).toBeGreaterThan(1);
    expect(new Set(turnRecords.map((record) => record.metadata?.logicalTurnId as string | undefined)).size).toBe(1);
  });

  test("recoverActiveIdentity returns the round carrying both ids, not a cobbled-together pair", async () => {
    const rootDir = await createPromptRoot();
    const store = await createSessionStore(rootDir, "recover");
    await store.append({ role: "system", content: "prompt", metadata: { engine: "etl" } });
    await store.append({ role: "user", content: "first", metadata: { logicalTurnId: "t1", providerRoundId: "r1" } });
    await store.append({ role: "assistant", content: "reply", metadata: { logicalTurnId: "t2", providerRoundId: "r2" } });
    // A trailing host marker persists only a logical turn id (no round). The
    // recovered round must be r2 (the assistant that produced the pause), not a
    // t2/r1 cobble from scanning each id independently.
    await store.append({ role: "system", content: "", metadata: { logicalTurnId: "t2" } });

    const records = await loadSessionRecords(rootDir, store.sessionId);
    const recovered = recoverActiveIdentity(records);
    expect(recovered).toEqual({ logicalTurnId: "t2", providerRoundId: "r2" });
  });
});
