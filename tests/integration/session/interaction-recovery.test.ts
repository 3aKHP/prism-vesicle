import { mkdtemp, } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { createSessionStore, listSessions, loadSessionMessages, loadSessionSnapshot } from "../../../src/core/session/store";

describe("session: interaction recovery", () => {
  test("loadSessionMessages synthesizes tool results for an unresolved gate (CR B1)", async () => {
    // A session that paused at a gate ends with an assistant message
    // carrying a request_confirmation tool call but no tool result (the
    // user never resolved the gate). Resume must synthesise a placeholder
    // tool result so the provider does not reject the dangling tool_calls.
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-dangling-"));
    const store = await createSessionStore(rootDir, "2026-04-01T00-00-00-000Z-dddddddd");

    await store.append({ role: "system", content: "prompt" });
    await store.append({ role: "user", content: "draft a blueprint" });
    await store.append({
      role: "assistant",
      content: "here is the blueprint",
      metadata: {
        toolCalls: [{ id: "call-gate", name: "request_confirmation", arguments: "{}" }],
      },
    });
    // No tool result record — this is the gate-paused state.

    const messages = await loadSessionMessages(rootDir, "2026-04-01T00-00-00-000Z-dddddddd");

    // user, assistant(gate), tool(synthetic)
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    expect(messages[2].toolCallId).toBe("call-gate");
    // The synthetic result must signal unresolved, not success.
    expect(messages[2].content).toContain("not resolved");
  });

  test("loadSessionSnapshot preserves an unresolved gate for interactive resume", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-pending-gate-"));
    const store = await createSessionStore(rootDir, "2026-04-01T00-00-00-000Z-ffffffff");

    await store.append({ role: "system", content: "prompt" });
    await store.append({ role: "user", content: "draft a blueprint" });
    await store.append({
      role: "assistant",
      content: "here is the blueprint",
      metadata: {
        toolCalls: [{
          id: "call-gate",
          name: "request_confirmation",
          arguments: JSON.stringify({ gate: "blueprint-confirmation", summary: "Concept: A" }),
        }],
      },
    });

    const summaries = await listSessions(rootDir);
    expect(summaries[0].pendingGate?.gate).toBe("blueprint-confirmation");

    const snapshot = await loadSessionSnapshot(rootDir, "2026-04-01T00-00-00-000Z-ffffffff");
    expect(snapshot.pendingGate?.toolCallId).toBe("call-gate");
    expect(snapshot.pendingGate?.gate.summary).toBe("Concept: A");
    expect(snapshot.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  test("loadSessionSnapshot preserves an unresolved engine switch for interactive resume", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-pending-engine-"));
    const store = await createSessionStore(rootDir, "2026-04-01T00-00-00-000Z-engine");

    await store.append({ role: "system", content: "prompt", metadata: { engine: "etl" } });
    await store.append({ role: "user", content: "handoff" });
    await store.append({
      role: "assistant",
      content: "Runtime should continue.",
      metadata: {
        toolCalls: [
          {
            id: "call-engine",
            name: "request_engine_switch",
            arguments: JSON.stringify({
              targetEngine: "runtime",
              reason: "Runtime owns turn simulation.",
              handoffSummary: "Cards are ready.",
            }),
          },
        ],
      },
    });

    const summaries = await listSessions(rootDir);
    expect(summaries[0].pendingEngineSwitch?.targetEngine).toBe("runtime");

    const snapshot = await loadSessionSnapshot(rootDir, "2026-04-01T00-00-00-000Z-engine");
    expect(snapshot.pendingEngineSwitch?.toolCallId).toBe("call-engine");
    expect(snapshot.pendingEngineSwitch?.request.handoffSummary).toBe("Cards are ready.");
    expect(snapshot.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  test("loadSessionSnapshot preserves engine handoff packets as user-role context", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-engine-handoff-"));
    const store = await createSessionStore(rootDir, "2026-04-01T00-00-00-000Z-handoff");

    await store.append({ role: "system", content: "prompt", metadata: { engine: "etl" } });
    await store.append({ role: "user", content: "start" });
    await store.append({ role: "assistant", content: "ready" });
    await store.append({
      role: "system",
      content: "Engine switched to runtime.",
      metadata: {
        kind: "engine-switch",
        engine: "runtime",
      },
    });
    await store.append({
      role: "user",
      content: "[engine_handoff]\nSource: manual\n[/engine_handoff]",
      metadata: {
        kind: "engine-handoff",
        engine: "runtime",
      },
    });

    const snapshot = await loadSessionSnapshot(rootDir, "2026-04-01T00-00-00-000Z-handoff");
    expect(snapshot.engine).toBe("runtime");
    expect(snapshot.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(snapshot.messages.at(-1)).toMatchObject({
      role: "user",
      kind: "engine-handoff",
      content: "[engine_handoff]\nSource: manual\n[/engine_handoff]",
    });
  });

  test("loadSessionSnapshot preserves an unresolved user question for interactive resume", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-pending-question-"));
    const store = await createSessionStore(rootDir, "2026-04-01T00-00-00-000Z-question");

    await store.append({ role: "system", content: "prompt", metadata: { engine: "etl" } });
    await store.append({ role: "user", content: "ask" });
    await store.append({
      role: "assistant",
      content: "Choose one.",
      metadata: {
        toolCalls: [
          {
            id: "call-question",
            name: "ask_user_question",
            arguments: JSON.stringify({
              header: "Scope",
              question: "Which scope should I use?",
              options: [
                { label: "Narrow", description: "Minimum change." },
                { label: "Broad", description: "Include cleanup." },
              ],
            }),
          },
        ],
      },
    });

    const summaries = await listSessions(rootDir);
    expect(summaries[0].pendingUserQuestion?.header).toBe("Scope");

    const snapshot = await loadSessionSnapshot(rootDir, "2026-04-01T00-00-00-000Z-question");
    expect(snapshot.pendingUserQuestion?.toolCallId).toBe("call-question");
    expect(snapshot.pendingUserQuestion?.question.options[1].label).toBe("Broad");
    expect(snapshot.pendingUserQuestion?.question.options.map((option) => option.label)).toEqual(["Narrow", "Broad", "Skip", "Answer freely"]);
    expect(snapshot.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  test("does not revive an older dangling interaction past the latest assistant turn", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-stale-interaction-"));
    const sessionId = "2026-04-01T00-00-00-000Z-stale";
    const store = await createSessionStore(rootDir, sessionId);

    await store.append({ role: "system", content: "prompt" });
    await store.append({ role: "user", content: "draft a blueprint" });
    await store.append({
      role: "assistant",
      content: "Review this blueprint.",
      metadata: {
        toolCalls: [{
          id: "call-old-gate",
          name: "request_confirmation",
          arguments: JSON.stringify({ gate: "blueprint-confirmation", summary: "Old request" }),
        }],
      },
    });
    await store.append({ role: "user", content: "Continue without that request." });
    await store.append({ role: "assistant", content: "Continued." });

    expect((await listSessions(rootDir))[0]?.pendingGate).toBeUndefined();
    expect((await loadSessionSnapshot(rootDir, sessionId)).pendingGate).toBeUndefined();
  });

});
