import { readFile, } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runPrompt } from "../../../src/core/agent-loop/run";
import { AgentManager } from "../../../src/core/agents/manager";
import { AgentStore } from "../../../src/core/agents/store";
import { runChildAgent } from "../../../src/core/agents/child-runner";
import { AgentContinuationScheduler } from "../../../src/core/agents/scheduler";
import { createSessionStore, } from "../../../src/core/session/store";
import { resolveProjectHarnessRuntime } from "../../../src/core/harness";
import { eventually } from "../../support/async/eventually";
import { configureTestProviderEnv, createPromptRoot, restoreAgentLoopTestState, } from "./fixtures/agent-loop";

beforeEach(configureTestProviderEnv);
afterEach(restoreAgentLoopTestState);

describe("agent loop: subagent background", () => {
  test("background SubAgent returns accepted without blocking the parent", async () => {
    const rootDir = await createPromptRoot();
    const store = new AgentStore(rootDir);
    const manager = new AgentManager(store, runChildAgent);
    let resolveChild: (response: Response) => void = () => undefined;
    let childStarted = false;
    let parentRequests = 0;
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const system = String(body.messages?.[0]?.content ?? "");
      if (system.includes("Explore Agent")) {
        childStarted = true;
        return new Promise<Response>((resolve) => { resolveChild = resolve; });
      }
      parentRequests += 1;
      if (parentRequests === 1) {
        return Response.json({
          id: "parent-background",
          choices: [{ message: {
            content: "Starting background exploration.",
            tool_calls: [{
              id: "call-background",
              type: "function",
              function: { name: "spawn_agent", arguments: JSON.stringify({ profile: "explore", description: "Explore later", prompt: "Explore in background.", mode: "background" }) },
            }],
          } }],
        });
      }
      const tool = body.messages.find((message: any) => message.role === "tool");
      expect(tool.content).toContain("accepted");
      return Response.json({ id: "parent-free", choices: [{ message: { content: "Parent is free." } }] });
    }) as typeof fetch;

    const result = await runPrompt({ input: "start background", rootDir, agentManager: manager });
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") return;
    expect(result.response.content).toBe("Parent is free.");
    expect(manager.listActive(result.sessionId)).toHaveLength(1);
    await eventually(() => expect(childStarted).toBe(true));
    resolveChild(Response.json({ id: "child-later", choices: [{ message: { content: "late result" } }] }));
    await eventually(async () => expect(await store.listInbox(result.sessionId, "pending")).toHaveLength(1));
  });

  test("delivers background completion through an automatic parent continuation", async () => {
    const rootDir = await createPromptRoot();
    const store = new AgentStore(rootDir);
    const manager = new AgentManager(store, runChildAgent);
    let resolveChild: (response: Response) => void = () => undefined;
    let childStarted = false;
    let parentRequests = 0;
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const system = String(body.messages?.[0]?.content ?? "");
      if (system.includes("Explore Agent")) {
        childStarted = true;
        return new Promise<Response>((resolve) => { resolveChild = resolve; });
      }
      parentRequests += 1;
      if (parentRequests === 1) {
        return Response.json({
          id: "parent-background-start",
          choices: [{ message: {
            content: "Delegating.",
            tool_calls: [{
              id: "call-auto-background",
              type: "function",
              function: { name: "spawn_agent", arguments: JSON.stringify({ profile: "explore", description: "Explore automatically", prompt: "Explore.", mode: "background" }) },
            }],
          } }],
        });
      }
      if (parentRequests === 2) return Response.json({ id: "parent-continues", choices: [{ message: { content: "Continuing while it runs." } }] });
      expect(body.messages.at(-1).content).toContain("<subagent-results>");
      return Response.json({ id: "parent-integrates", choices: [{ message: { content: "Integrated late evidence." } }] });
    }) as typeof fetch;

    const initial = await runPrompt({ input: "start", rootDir, agentManager: manager });
    expect(initial.kind).toBe("complete");
    if (initial.kind !== "complete") return;
    await eventually(() => expect(childStarted).toBe(true));
    resolveChild(Response.json({ id: "child-complete", choices: [{ message: { content: "late evidence" } }] }));
    await eventually(async () => expect(await store.listInbox(initial.sessionId, "pending")).toHaveLength(1));
    let integrated = "";
    const scheduler = new AgentContinuationScheduler(store, async (parentSessionId, _entries, packet) => {
      const continuation = await runPrompt({
        input: packet,
        rootDir,
        sessionId: parentSessionId,
        messages: [...initial.messages, { role: "user", content: packet }],
        agentManager: manager,
      });
      if (continuation.kind !== "complete") throw new Error("expected complete continuation");
      integrated = continuation.response.content;
    }, { debounceMs: 0 });
    await scheduler.notify(initial.sessionId);
    expect(integrated).toBe("Integrated late evidence.");
    expect(await store.listInbox(initial.sessionId, "acknowledged")).toHaveLength(1);
  });

  test("reuses a pre-persisted durable delivery input without appending it twice", async () => {
    const rootDir = await createPromptRoot();
    const session = await createSessionStore(rootDir);
    const harness = await resolveProjectHarnessRuntime(rootDir);
    await session.append({
      role: "system",
      content: "parent",
      metadata: { harness: harness?.harness.identity },
    });
    const delivery = await session.append({
      role: "user",
      content: "<subagent-results>done</subagent-results>",
      metadata: { kind: "subagent-results", inboxIds: ["inbox-1"] },
    });
    globalThis.fetch = (async () => Response.json({
      id: "delivery-retry",
      choices: [{ message: { content: "integrated" } }],
    })) as unknown as typeof fetch;

    const result = await runPrompt({
      input: "<subagent-results>done</subagent-results>",
      rootDir,
      sessionId: session.sessionId,
      messages: [{ role: "user", content: "<subagent-results>done</subagent-results>" }],
      prePersistedInputUuid: delivery.uuid,
    });
    expect(result.kind).toBe("complete");
    const records = (await readFile(session.sessionPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(records.filter((record) => record.metadata?.kind === "subagent-results")).toHaveLength(1);
  });
});
