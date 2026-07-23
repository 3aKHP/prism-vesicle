import { rm, } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { AgentManager } from "../../../src/core/agents/manager";
import { agentToolDefinitions, executeAgentTool } from "../../../src/core/agents/tools";
import { ToolPermissionBroker } from "../../../src/core/permissions";
import { loadSessionRecords, loadSessionSnapshot } from "../../../src/core/session/store";
import { resolvePermission, runPrompt } from "../../../src/core/agent-loop/run";
import { runChildAgent } from "../../../src/core/agents/child-runner";
import { eventually } from "../../support/async/eventually";
import { configureFixtureProvider, delegationFixture, spawnCall, } from "./fixtures/harness";

describe("harness delegation: permission broker", () => {
  test("keeps released child tools reduced and brokers MANUAL mutation through the parent", async () => {
    const fixture = await delegationFixture();
    const originalProvidersFile = process.env.VESICLE_PROVIDERS_FILE;
    const originalFetch = globalThis.fetch;
    try {
      await configureFixtureProvider(fixture.root);
      const broker = new ToolPermissionBroker();
      const visibleTools: string[][] = [];

      async function runCase(path: string, decision: "allow_once" | "reject") {
        globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
          const body = JSON.parse(String(init?.body));
          visibleTools.push((body.tools ?? []).map((tool: any) => tool.function.name));
          if (!body.messages.some((message: any) => message.role === "tool")) {
            return Response.json({
              id: `child-${decision}-tool`,
              choices: [{ message: {
                content: "",
                tool_calls: [{
                  id: `call-${decision}-write`,
                  type: "function",
                  function: {
                    name: "write_file",
                    arguments: JSON.stringify({ path, content: decision }),
                  },
                }],
              } }],
            });
          }
          return Response.json({ id: `child-${decision}-done`, choices: [{ message: { content: `${decision} handled` } }] });
        }) as typeof fetch;

        const manager = new AgentManager(fixture.store, runChildAgent);
        const execution = executeAgentTool({
          call: spawnCall(`call-${decision}-child`, "scene-writer"),
          manager,
          rootDir: fixture.root,
          parentSessionId: "parent",
          invocation: {
            ...fixture.invocation,
            providerSelection: { provider: "test", model: "test-model" },
            parentToolDefinitions: agentToolDefinitions,
            permission: { mode: "MANUAL" },
            permissionBroker: broker,
          },
        });
        await eventually(() => expect(broker.active()).toMatchObject({
          toolName: "write_file",
          agent: expect.objectContaining({ parentSessionId: "parent" }),
        }));
        const request = broker.active()!;
        expect(broker.resolve(request.id, {
          decision,
          resolvedAt: new Date().toISOString(),
          ...(decision === "reject" ? { feedback: "Do not write this file." } : {}),
        })).toBe(true);
        const result = await execution;
        expect(result.ok).toBe(true);
        const publicResult = JSON.parse(result.content) as { agent_id: string };
        const stored = await fixture.store.resolveReference("parent", publicResult.agent_id);
        const records = await loadSessionRecords(fixture.root, stored!.childSessionId!);
        expect((await loadSessionSnapshot(fixture.root, stored!.childSessionId!)).harness)
          .toEqual(fixture.invocation.harness?.identity);
        expect(records.some((record) => record.metadata?.kind === "permission-request")).toBe(true);
        expect(records).toContainEqual(expect.objectContaining({
          metadata: expect.objectContaining({
            kind: "permission-resolution",
            decision,
            decisionSource: "user",
          }),
        }));
      }

      await runCase("workspace/allowed.md", "allow_once");
      expect(await Bun.file(join(fixture.root, "workspace", "allowed.md")).exists()).toBe(true);
      await runCase("workspace/denied.md", "reject");
      expect(await Bun.file(join(fixture.root, "workspace", "denied.md")).exists()).toBe(false);
      for (const tools of visibleTools) {
        expect(tools).toContain("write_file");
        expect(tools).not.toContain("spawn_agent");
        expect(tools).not.toContain("ask_user_question");
        expect(tools).not.toContain("shell_exec");
      }
    } finally {
      globalThis.fetch = originalFetch;
      if (originalProvidersFile === undefined) delete process.env.VESICLE_PROVIDERS_FILE;
      else process.env.VESICLE_PROVIDERS_FILE = originalProvidersFile;
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("normalizes a parent MANUAL denial of Harness spawn as ABI denied", async () => {
    const fixture = await delegationFixture();
    const originalProvidersFile = process.env.VESICLE_PROVIDERS_FILE;
    const originalFetch = globalThis.fetch;
    let runnerCalls = 0;
    let providerCalls = 0;
    try {
      await configureFixtureProvider(fixture.root);
      globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
        providerCalls += 1;
        const body = JSON.parse(String(init?.body));
        if (providerCalls === 1) {
          return Response.json({
            id: "parent-manual-delegation",
            choices: [{ message: {
              content: "",
              tool_calls: [{
                id: "call-manual-delegation",
                type: "function",
                function: {
                  name: "spawn_agent",
                  arguments: spawnCall("ignored", "scene-writer").arguments,
                },
              }],
            } }],
          });
        }
        const denied = body.messages.find((message: any) => message.role === "tool");
        const envelope = JSON.parse(String(denied?.content ?? "{}"));
        expect(JSON.parse(envelope.result ?? "{}")).toMatchObject({
          error: { category: "denied", message: expect.stringContaining("Do not delegate") },
        });
        return Response.json({ id: "parent-after-denial", choices: [{ message: { content: "denial handled" } }] });
      }) as typeof fetch;
      const manager = new AgentManager(fixture.store, async () => {
        runnerCalls += 1;
        return { content: "must not run" };
      });
      const paused = await runPrompt({
        input: "delegate",
        engine: "weaver-orch",
        rootDir: fixture.root,
        providerSelection: { provider: "test", model: "test-model" },
        permission: { mode: "MANUAL" },
        harness: fixture.invocation.harness,
        assets: fixture.invocation.assets,
        agentManager: manager,
      });
      if (paused.kind !== "needs_permission") throw new Error("expected permission pause");
      const resumed = await resolvePermission({
        engine: "weaver-orch",
        rootDir: fixture.root,
        sessionId: paused.sessionId,
        messages: paused.messages,
        request: paused.request,
        remainingToolCalls: paused.remainingToolCalls,
        resolution: {
          decision: "reject",
          resolvedAt: new Date().toISOString(),
          feedback: "Do not delegate.",
        },
        providerSelection: { provider: "test", model: "test-model" },
        permission: { mode: "MANUAL" },
        harness: fixture.invocation.harness,
        assets: fixture.invocation.assets,
        agentManager: manager,
      });
      expect(resumed.kind).toBe("complete");
      expect(runnerCalls).toBe(0);
      expect(providerCalls).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalProvidersFile === undefined) delete process.env.VESICLE_PROVIDERS_FILE;
      else process.env.VESICLE_PROVIDERS_FILE = originalProvidersFile;
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

});
