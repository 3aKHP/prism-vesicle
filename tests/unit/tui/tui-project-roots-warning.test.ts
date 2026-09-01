import { createRoot } from "solid-js";
import { describe, expect, test } from "bun:test";
import type { AgentLoopEvent } from "../../../src/core/agent-loop/run";
import { agentProcessControllerHarness } from "./support/agent-process-controller-harness";

type RootsWarningEvent = Extract<AgentLoopEvent, { type: "project_roots_warning" }>;

function rootsWarningEvent(failures: RootsWarningEvent["failures"], sessionId = "session-1"): RootsWarningEvent {
  return { type: "project_roots_warning", sessionId, failures };
}

describe("project roots warning notice", () => {
  test("appends one combined system message naming each failed root and records activity", () => createRoot((dispose) => {
    const { controller, messages, activity } = agentProcessControllerHarness();

    controller.handleAgentEvent(rootsWarningEvent([
      { root: "workspace", message: "EEXIST: file exists" },
      { root: "tmp", message: "EACCES: permission denied" },
    ]));

    const system = messages().filter((message) => message.role === "system");
    expect(system.length).toBe(1);
    expect(system[0]!.content).toContain('"workspace"');
    expect(system[0]!.content).toContain('"tmp"');
    expect(activity().some((entry) => entry.kind === "system" && entry.text.includes("2 project roots"))).toBe(true);
    dispose();
  }));

  test("ignores an empty failure list", () => createRoot((dispose) => {
    const { controller, messages, activity } = agentProcessControllerHarness();

    controller.handleAgentEvent(rootsWarningEvent([]));

    expect(messages().length).toBe(0);
    expect(activity().length).toBe(0);
    dispose();
  }));

  test("does not repeat the notice for the same session", () => createRoot((dispose) => {
    const { controller, messages } = agentProcessControllerHarness();

    controller.handleAgentEvent(rootsWarningEvent([{ root: "workspace", message: "EEXIST" }]));
    controller.handleAgentEvent(rootsWarningEvent([{ root: "workspace", message: "EEXIST" }]));

    expect(messages().filter((message) => message.role === "system").length).toBe(1);
    dispose();
  }));

  test("dedups per session id, so distinct sessions both notify", () => createRoot((dispose) => {
    const { controller, messages } = agentProcessControllerHarness();

    controller.handleAgentEvent(rootsWarningEvent([{ root: "workspace", message: "EEXIST" }], "session-a"));
    controller.handleAgentEvent(rootsWarningEvent([{ root: "workspace", message: "EEXIST" }], "session-b"));

    expect(messages().filter((message) => message.role === "system").length).toBe(2);
    dispose();
  }));
});
