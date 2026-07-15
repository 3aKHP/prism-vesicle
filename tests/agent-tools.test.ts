import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { AgentManager } from "../src/core/agents/manager";
import { AgentStore } from "../src/core/agents/store";
import { agentToolProgress, composeChildSystemPrompts, resolveChildTools } from "../src/core/agents/child-runner";
import { agentToolDefinitions, executeAgentTool } from "../src/core/agents/tools";
import { fileToolDefinitions } from "../src/core/tools";
import type { AgentInvocationContext } from "../src/core/agents/types";
import { toChatCompletionBody } from "../src/providers/openai-chat/request";
import { toAnthropicMessagesBody } from "../src/providers/anthropic-messages/adapter";
import { toGeminiGenerateContentBody } from "../src/providers/gemini-generate-content/adapter";
import type { VesicleRequest } from "../src/providers/shared/types";

describe("SubAgent model tools", () => {
  test("renders useful bounded progress from child tool arguments", () => {
    expect(agentToolProgress({
      id: "call-read",
      name: "read_file",
      arguments: JSON.stringify({ path: "source_materials/chapter-12.md" }),
    })).toBe("tool read_file · source_materials/chapter-12.md");
  });

  test("fork context preserves the exact parent prefix and the independent Agent prompt", () => {
    const parent = "rendered parent Engine prompt";
    const agent = "custom continuity Agent prompt";
    expect(composeChildSystemPrompts("fork", parent, agent)).toEqual([parent, agent]);
    expect(composeChildSystemPrompts("summary", parent, agent)).toEqual([agent]);
  });

  test("wildcard profiles inherit work tools without recursive Agent controls", () => {
    const definitions = [...fileToolDefinitions, ...agentToolDefinitions];
    const mcp = { definitions: [], statuses: [], hasTool: () => false, execute: async () => { throw new Error("unexpected MCP call"); } };
    const tools = resolveChildTools(["*"], definitions, mcp, true);
    expect(tools.map((tool) => tool.function.name)).toContain("read_file");
    expect(tools.map((tool) => tool.function.name)).not.toContain("spawn_agent");
    expect(() => resolveChildTools(["spawn_agent"], definitions, mcp, true)).toThrow("cannot use interactive or recursive tool");
  });

  test("returns immediately for background spawn and persists the eventual result", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-agent-tool-"));
    let release: () => void = () => undefined;
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    try {
      const store = new AgentStore(rootDir);
      const manager = new AgentManager(store, async () => {
        markStarted();
        await new Promise<void>((resolve) => { release = resolve; });
        return { content: "done" };
      });
      const result = await executeAgentTool({
        call: {
          id: "call-spawn",
          name: "spawn_agent",
          arguments: JSON.stringify({ profile: "explore", description: "Explore", prompt: "Explore this.", mode: "background" }),
        },
        manager,
        rootDir,
        parentSessionId: "parent",
        invocation: invocation(rootDir),
      });
      expect(result.ok).toBe(true);
      expect(result.content).toContain('"status":"accepted"');
      const agentId = JSON.parse(result.content).agent_id as string;
      expect(agentId).toBe("explore-1");
      expect(manager.listActive("parent").map((agent) => agent.handle)).toContain(agentId);
      const listed = await executeAgentTool({
        call: { id: "call-list", name: "list_agents", arguments: "{}" },
        manager,
        rootDir,
        parentSessionId: "parent",
        invocation: invocation(rootDir),
      });
      expect(listed.content).toContain('"agent_id":"explore-1"');
      expect(listed.content).not.toContain("run_");
      await started;
      release();
      expect((await manager.wait(agentId, "parent"))?.status).toBe("completed");
      expect(await store.listInbox("parent", "pending")).toHaveLength(1);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  test("sanitizes model-provided Agent descriptions before display and persistence", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-agent-tool-description-"));
    try {
      const store = new AgentStore(rootDir);
      const manager = new AgentManager(store, async () => ({ content: "done" }));
      const result = await executeAgentTool({
        call: {
          id: "call-description",
          name: "spawn_agent",
          arguments: JSON.stringify({ profile: "plan", description: "Plan\n\u001b[31m  the   arc", prompt: "Plan." }),
        },
        manager,
        rootDir,
        parentSessionId: "parent",
        invocation: invocation(rootDir),
      });
      expect(result.ok).toBe(true);
      const stored = await store.resolveReference("parent", "plan-1");
      expect(stored?.description).toBe("Plan the arc");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  test("foreground spawn returns the terminal child result", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-agent-tool-foreground-"));
    try {
      const manager = new AgentManager(new AgentStore(rootDir), async () => ({ content: "plan" }));
      const result = await executeAgentTool({
        call: {
          id: "call-plan",
          name: "spawn_agent",
          arguments: JSON.stringify({ profile: "plan", description: "Plan", prompt: "Plan this.", mode: "foreground" }),
        },
        manager,
        rootDir,
        parentSessionId: "parent",
        invocation: invocation(rootDir),
      });
      expect(result.ok).toBe(true);
      expect(result.content).toContain('"content":"plan"');
      expect(result.content).toContain('"agent_id":"plan-1"');
      expect(result.content).not.toContain("run_");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  test("explicit wait consumes a background result without later inbox delivery", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-agent-tool-wait-"));
    try {
      const store = new AgentStore(rootDir);
      const manager = new AgentManager(store, async () => ({ content: "background evidence" }));
      const child = await manager.spawn({
        profileId: "explore",
        description: "Explore",
        prompt: "Explore.",
        mode: "background",
        parentSessionId: "parent",
        parentToolCallId: "call-spawn",
      }, invocation(rootDir));
      expect((await child.completion).status).toBe("completed");
      expect(await store.listInbox("parent", "pending")).toHaveLength(1);

      const waited = await executeAgentTool({
        call: { id: "call-wait", name: "wait_agent", arguments: JSON.stringify({ agent_id: child.handle }) },
        manager,
        rootDir,
        parentSessionId: "parent",
        invocation: invocation(rootDir),
      });

      expect(waited.ok).toBe(true);
      expect(await store.listInbox("parent", "pending")).toHaveLength(0);
      expect(await store.listInbox("parent", "acknowledged")).toHaveLength(1);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  test("rejects unknown profiles without spawning a child", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-agent-tool-invalid-"));
    try {
      const manager = new AgentManager(new AgentStore(rootDir), async () => ({ content: "unexpected" }));
      const result = await executeAgentTool({
        call: {
          id: "call-invalid",
          name: "spawn_agent",
          arguments: JSON.stringify({ profile: "missing", description: "Missing", prompt: "No." }),
        },
        manager,
        rootDir,
        parentSessionId: "parent",
        invocation: invocation(rootDir),
      });
      expect(result.ok).toBe(false);
      expect(result.content).toContain("not found");
      expect(manager.listActive()).toHaveLength(0);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  test("preserves spawn tool calls and results across all three provider protocols", () => {
    const request: VesicleRequest = {
      id: "parent",
      model: { provider: "test", model: "model" },
      system: ["system"],
      tools: agentToolDefinitions,
      messages: [
        {
          role: "assistant",
          content: "Delegating.",
          toolCalls: [{ id: "call-agent", name: "spawn_agent", arguments: '{"profile":"explore","description":"Explore","prompt":"Inspect."}' }],
        },
        { role: "tool", toolCallId: "call-agent", content: '{"ok":true,"result":"accepted"}' },
      ],
    };
    const openai = toChatCompletionBody(request, false) as any;
    expect(openai.tools.map((tool: any) => tool.function.name)).toContain("spawn_agent");
    expect(openai.messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "call-agent" });

    const anthropic = toAnthropicMessagesBody(request) as any;
    expect(anthropic.tools.map((tool: any) => tool.name)).toContain("spawn_agent");
    expect(anthropic.messages.at(-1).content[0]).toMatchObject({ type: "tool_result", tool_use_id: "call-agent" });

    const gemini = toGeminiGenerateContentBody(request) as any;
    expect(gemini.tools[0].functionDeclarations.map((tool: any) => tool.name)).toContain("spawn_agent");
    expect(gemini.contents.at(-1).parts[0].functionResponse).toMatchObject({ id: "call-agent", name: "spawn_agent" });
  });
});

function invocation(rootDir: string): AgentInvocationContext {
  return {
    rootDir,
    parentEngine: "etl",
    parentToolDefinitions: [],
    parentSystemPrompt: "parent",
    parentMessages: [],
  };
}
