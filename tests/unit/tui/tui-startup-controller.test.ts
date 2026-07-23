import { expect, test } from "bun:test";
import type { AgentMetadata } from "../../../src/core/agents/types";
import type { SessionSummary } from "../../../src/core/session/store";
import { createStartupController } from "../../../src/tui/startup-controller";
import type { Message, SessionPickerState } from "../../../src/tui/types";

test("startup coordinates recovery and opens the requested resume picker", async () => {
  const session: SessionSummary = {
    sessionId: "session-1",
    startedAt: "2026-07-24T00:00:00.000Z",
    updatedAt: "2026-07-24T00:01:00.000Z",
    recordCount: 2,
    preview: "existing work",
  };
  const recovered = [
    recoveredAgent("background", "parent-background"),
    recoveredAgent("foreground", "parent-foreground"),
  ];
  const calls: string[] = [];
  const notified: string[] = [];
  const errors: unknown[] = [];
  let messages: Message[] = [];
  let resumableSessions: SessionSummary[] = [];
  let picker: SessionPickerState | null = null;
  let status = "loading";
  let providerReady = false;
  const controller = createStartupController({
    dangerouslySkipPermissions: true,
    initialResume: true,
    refreshArtifacts: async () => { calls.push("artifacts"); },
    recoverInterruptedAgents: async () => recovered,
    notifyContinuation: async (sessionId) => { notified.push(sessionId); },
    refreshMcpStatus: async () => { calls.push("mcp"); },
    loadPermissionSettings: async () => { calls.push("permissions"); },
    loadProviderConfig: async () => { calls.push("provider"); throw new Error("provider failed"); },
    setProviderConfigReady: (ready) => { providerReady = ready; },
    listSessions: async () => [session],
    setResumableSessions: (sessions) => { resumableSessions = sessions; },
    setSessionPicker: (state) => { picker = state; },
    setMessages: (value) => { messages = typeof value === "function" ? value(messages) : value; },
    setStatus: (value) => { status = value; },
    reportError: (error) => { errors.push(error); },
  });

  await controller.start();

  expect(calls.sort()).toEqual(["artifacts", "mcp", "provider"]);
  expect(notified).toEqual(["parent-background"]);
  expect(messages.map((message) => message.content)).toEqual([
    "Recovered 2 interrupted SubAgents; foreground tool calls were closed and background failures will be delivered when their parent sessions resume.",
  ]);
  expect(resumableSessions).toEqual([session]);
  expect(picker as unknown).toEqual({ sessions: [session], selected: 0 });
  expect(status).toBe("choose a session to resume");
  expect(providerReady).toBe(true);
  expect(errors).toHaveLength(1);
});

test("startup loads normal permissions and reports resumable sessions", async () => {
  const session: SessionSummary = {
    sessionId: "session-2",
    startedAt: "2026-07-24T00:00:00.000Z",
    updatedAt: "2026-07-24T00:01:00.000Z",
    recordCount: 1,
    preview: "resume me",
  };
  const calls: string[] = [];
  let messages: Message[] = [];
  let picker: SessionPickerState | null = null;
  const controller = createStartupController({
    dangerouslySkipPermissions: false,
    initialResume: false,
    refreshArtifacts: async () => undefined,
    recoverInterruptedAgents: async () => [],
    notifyContinuation: async () => undefined,
    refreshMcpStatus: async () => undefined,
    loadPermissionSettings: async () => { calls.push("permissions"); },
    loadProviderConfig: async () => undefined,
    setProviderConfigReady: () => undefined,
    listSessions: async () => [session],
    setResumableSessions: () => undefined,
    setSessionPicker: (state) => { picker = state; },
    setMessages: (value) => { messages = typeof value === "function" ? value(messages) : value; },
    setStatus: () => undefined,
    reportError: (error) => { throw error; },
  });

  await controller.start();

  expect(calls).toEqual(["permissions"]);
  expect(picker).toBeNull();
  expect(messages.map((message) => message.content)).toEqual([
    "Found 1 existing session. Type /resume to list and continue one, or just type a new prompt to start fresh.",
  ]);
});

test("startup reports an empty explicit resume request", async () => {
  let messages: Message[] = [];
  const controller = createStartupController({
    dangerouslySkipPermissions: true,
    initialResume: true,
    refreshArtifacts: async () => undefined,
    recoverInterruptedAgents: async () => [],
    notifyContinuation: async () => undefined,
    refreshMcpStatus: async () => undefined,
    loadPermissionSettings: async () => undefined,
    loadProviderConfig: async () => undefined,
    setProviderConfigReady: () => undefined,
    listSessions: async () => [],
    setResumableSessions: () => undefined,
    setSessionPicker: () => undefined,
    setMessages: (value) => { messages = typeof value === "function" ? value(messages) : value; },
    setStatus: () => undefined,
    reportError: (error) => { throw error; },
  });

  await controller.start();

  expect(messages.map((message) => message.content)).toEqual(["No existing sessions found."]);
});

function recoveredAgent(mode: "background" | "foreground", parentSessionId: string): AgentMetadata {
  return {
    runId: `run-${mode}`,
    handle: `explore-${mode}`,
    profileId: "explore",
    description: "Recovered agent",
    prompt: "inspect",
    mode,
    parentSessionId,
    parentToolCallId: `call-${mode}`,
    status: "failed",
    createdAt: "2026-07-24T00:00:00.000Z",
    updatedAt: "2026-07-24T00:01:00.000Z",
  };
}
