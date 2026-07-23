import { readdir, } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resolvePermission, runPrompt } from "../../../src/core/agent-loop/run";
import { AgentManager } from "../../../src/core/agents/manager";
import { AgentStore } from "../../../src/core/agents/store";
import { loadSessionRecords, } from "../../../src/core/session/store";
import { eventually } from "../../support/async/eventually";
import { configureTestProviderEnv, createPromptRoot, restoreAgentLoopTestState, } from "./fixtures/agent-loop";

beforeEach(configureTestProviderEnv);
afterEach(restoreAgentLoopTestState);

describe("agent loop: subagent foreground", () => {
  test("reserves the contract delegation slot only for a valid non-host Agent profile", async () => {
    const rootDir = await createPromptRoot();
    let childRuns = 0;
    const manager = new AgentManager(new AgentStore(rootDir), async ({ spec }) => {
      childRuns += 1;
      return { content: `completed:${spec.profileId}` };
    });
    let parentRequests = 0;
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      parentRequests += 1;
      if (parentRequests === 1) {
        return Response.json({
          id: "parent-contract-parse",
          choices: [{ message: {
            content: "Delegating.",
            tool_calls: [
              {
                id: "call-malformed-agent",
                type: "function",
                function: { name: "spawn_agent", arguments: "{not-json" },
              },
              {
                id: "call-host-agent",
                type: "function",
                function: { name: "spawn_agent", arguments: JSON.stringify({
                  profile: " explore ",
                  description: "Explore sources",
                  prompt: "Map the sources.",
                  mode: "foreground",
                }) },
              },
              {
                id: "call-scene-writer",
                type: "function",
                function: { name: "spawn_agent", arguments: JSON.stringify({
                  profile: "scene-writer",
                  description: "Draft scene",
                  prompt: "Draft the next scene.",
                  mode: "foreground",
                }) },
              },
            ],
          } }],
        });
      }
      const toolMessages = body.messages.filter((message: any) => message.role === "tool");
      expect(toolMessages).toHaveLength(3);
      expect(toolMessages[0].content).toContain("Tool arguments must be valid JSON");
      expect(toolMessages[1].content).toContain("completed:explore");
      expect(toolMessages[2].content).toContain("completed:scene-writer");
      return Response.json({ id: "parent-contract-complete", choices: [{ message: { content: "Delegation complete." } }] });
    }) as typeof fetch;

    const result = await runPrompt({
      input: "delegate",
      engine: "weaver-orch",
      rootDir,
      agentManager: manager,
    });
    expect(result.kind).toBe("complete");
    expect(parentRequests).toBe(2);
    expect(childRuns).toBe(2);
  });

  test("launches multiple foreground SubAgents in parallel and resumes the same parent turn", async () => {
    const rootDir = await createPromptRoot();
    const childResolvers: Array<(response: Response) => void> = [];
    const childSystems: string[] = [];
    let parentRequests = 0;
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const system = String(body.messages?.[0]?.content ?? "");
      if (system.includes("Explore Agent") || system.includes("Reviewer Agent")) {
        childSystems.push(system);
        return new Promise<Response>((resolve) => childResolvers.push(resolve));
      }
      parentRequests += 1;
      if (parentRequests === 1) {
        return Response.json({
          id: "parent-spawn",
          choices: [{ message: {
            content: "Delegating both checks.",
            tool_calls: [
              {
                id: "call-explore",
                type: "function",
                function: { name: "spawn_agent", arguments: JSON.stringify({ profile: "explore", description: "Explore sources", prompt: "Map the sources.", mode: "foreground" }) },
              },
              {
                id: "call-review",
                type: "function",
                function: { name: "spawn_agent", arguments: JSON.stringify({ profile: "reviewer", description: "Review evidence", prompt: "Review the evidence.", mode: "foreground" }) },
              },
            ],
          } }],
        });
      }
      expect(body.messages.filter((message: any) => message.role === "tool")).toHaveLength(2);
      return Response.json({ id: "parent-complete", choices: [{ message: { content: "Combined child results." } }] });
    }) as typeof fetch;

    const turn = runPrompt({ input: "delegate", rootDir });
    await eventually(() => expect(childResolvers).toHaveLength(2));
    expect(parentRequests).toBe(1);
    childResolvers[0]!(Response.json({ id: "child-a", choices: [{ message: { content: "source map" } }] }));
    childResolvers[1]!(Response.json({ id: "child-b", choices: [{ message: { content: "review" } }] }));
    const result = await turn;
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") return;
    expect(result.response.content).toBe("Combined child results.");
    expect(parentRequests).toBe(2);
    expect(childSystems).toHaveLength(2);
  });

  test("keeps approved foreground SubAgents concurrent under MANUAL permissions", async () => {
    const rootDir = await createPromptRoot();
    const childResolvers: Array<(result: { content: string }) => void> = [];
    const manager = new AgentManager(new AgentStore(rootDir), async () => new Promise((resolve) => childResolvers.push(resolve)));
    let parentRequests = 0;
    globalThis.fetch = (async () => {
      parentRequests += 1;
      if (parentRequests === 1) return Response.json({
        id: "parent-manual-spawn",
        choices: [{ message: { content: "", tool_calls: [
          {
            id: "call-manual-a",
            type: "function",
            function: { name: "spawn_agent", arguments: JSON.stringify({ profile: "general", description: "Check A", prompt: "Check A", mode: "foreground" }) },
          },
          {
            id: "call-manual-b",
            type: "function",
            function: { name: "spawn_agent", arguments: JSON.stringify({ profile: "general", description: "Check B", prompt: "Check B", mode: "foreground" }) },
          },
        ] } }],
      });
      return Response.json({ id: "parent-manual-complete", choices: [{ message: { content: "combined" } }] });
    }) as unknown as typeof fetch;

    const first = await runPrompt({ input: "delegate", rootDir, agentManager: manager, permission: { mode: "MANUAL" } });
    expect(first.kind).toBe("needs_permission");
    if (first.kind !== "needs_permission") throw new Error("expected first permission");
    const second = await resolvePermission({
      engine: "etl",
      rootDir,
      sessionId: first.sessionId,
      messages: first.messages,
      request: first.request,
      remainingToolCalls: first.remainingToolCalls,
      resolution: { decision: "allow_once", resolvedAt: new Date().toISOString() },
      permission: { mode: "MANUAL" },
      agentManager: manager,
    });
    expect(second.kind).toBe("needs_permission");
    expect(childResolvers).toHaveLength(0);
    if (second.kind !== "needs_permission") throw new Error("expected second permission");
    await expect(resolvePermission({
      engine: "etl",
      rootDir,
      sessionId: second.sessionId,
      messages: second.messages,
      request: second.request,
      remainingToolCalls: second.remainingToolCalls,
      deferredAgentPermissions: second.deferredAgentPermissions?.map((entry) => ({
        ...entry,
        request: { ...entry.request, arguments: "{}" },
      })),
      resolution: { decision: "allow_once", resolvedAt: new Date().toISOString() },
      permission: { mode: "MANUAL" },
      agentManager: manager,
    })).rejects.toThrow("Deferred Agent permission batch");
    const completion = resolvePermission({
      engine: "etl",
      rootDir,
      sessionId: second.sessionId,
      messages: second.messages,
      request: second.request,
      remainingToolCalls: second.remainingToolCalls,
      deferredAgentPermissions: second.deferredAgentPermissions,
      resolution: { decision: "allow_once", resolvedAt: new Date().toISOString() },
      permission: { mode: "MANUAL" },
      agentManager: manager,
    });
    await eventually(() => expect(childResolvers).toHaveLength(2));
    childResolvers[0]!({ content: "A" });
    childResolvers[1]!({ content: "B" });
    expect((await completion).kind).toBe("complete");
    expect(parentRequests).toBe(2);
  });

  test("persists started SubAgent results before propagating a sibling host-tool error", async () => {
    const rootDir = await createPromptRoot();
    const childResolvers: Array<(result: { content: string }) => void> = [];
    const manager = new AgentManager(new AgentStore(rootDir), async () => new Promise((resolve) => childResolvers.push(resolve)));
    globalThis.fetch = (async () => Response.json({
      id: "parent-mixed-tools",
      choices: [{ message: {
        content: "Delegating while reading.",
        tool_calls: [
          {
            id: "call-child-a",
            type: "function",
            function: { name: "spawn_agent", arguments: JSON.stringify({ profile: "general", description: "Check evidence A", prompt: "Check the first evidence set.", mode: "foreground" }) },
          },
          {
            id: "call-child-b",
            type: "function",
            function: { name: "spawn_agent", arguments: JSON.stringify({ profile: "general", description: "Check evidence B", prompt: "Check the second evidence set.", mode: "foreground" }) },
          },
          {
            id: "call-read",
            type: "function",
            function: { name: "read_file", arguments: JSON.stringify({ path: "source_materials/missing.md" }) },
          },
        ],
      } }],
    })) as unknown as typeof fetch;

    const turn = runPrompt({
      input: "delegate and read",
      rootDir,
      agentManager: manager,
      onEvent: (event) => {
        if (event.type === "tool_result" && event.name === "read_file") throw new Error("host tool event failed");
      },
    });

    let turnSettled = false;
    const observedTurn = turn.finally(() => { turnSettled = true; });
    await eventually(() => expect(childResolvers).toHaveLength(2));
    childResolvers[0]!({ content: "child result A" });
    await Bun.sleep(0);
    expect(turnSettled).toBe(false);
    childResolvers[1]!({ content: "child result B" });
    await expect(observedTurn).rejects.toThrow("host tool event failed");
    const sessions = await readdir(join(rootDir, ".vesicle", "sessions"));
    const sessionId = sessions[0]!.replace(/\.jsonl$/, "");
    const records = await loadSessionRecords(rootDir, sessionId);
    const toolResults = records.filter((record) => record.role === "tool");
    expect(toolResults.map((record) => record.metadata?.toolCallId)).toEqual(["call-read", "call-child-a", "call-child-b"]);
    expect(toolResults.filter((record) => record.metadata?.kind === "subagent-result")).toHaveLength(2);
  });

});
