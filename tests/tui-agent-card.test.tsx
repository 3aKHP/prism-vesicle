import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { AgentCard } from "../src/tui/widgets/AgentCard";
import { agentActivitySummary, agentCardFromMetadata, applyAgentEvent, mergeRestoredAgentCards, renderAgentDetail, retryAgentDelivery, setAgentDeliveryState } from "../src/tui/agent-view";
import { agentSidebarLines } from "../src/tui/views/Sidebar";
import { displayTranscriptFromSnapshot, headerLine } from "../src/tui/app";
import type { AgentCardState } from "../src/tui/types";
import type { AgentMetadata } from "../src/core/agents/types";

describe("SubAgent TUI visibility", () => {
  test("renders a distinct readable Agent card at 80 columns", async () => {
    const setup = await testRender(() => <AgentCard agent={card()} width={76} />, { width: 80, height: 8 });
    await setup.flush();
    const frame = setup.captureCharFrame();
    setup.renderer.destroy();

    expect(frame).toContain("● explore-1 · explore · background");
    expect(frame).toContain("Mapping source materials");
    expect(frame).toContain("read_file · source_materials/chapter-12.md");
  });

  test("tracks ready, integrating, and integrated as separate delivery states", () => {
    const metadata = agentMetadata();
    let cards = [agentCardFromMetadata(metadata)];
    cards = applyAgentEvent(cards, {
      type: "agent_completed",
      result: {
        runId: metadata.runId,
        handle: metadata.handle,
        parentSessionId: metadata.parentSessionId,
        profileId: metadata.profileId,
        description: metadata.description,
        mode: "background",
        status: "completed",
        content: "Mapped 42 sources.",
      },
    });
    expect(cards[0]?.status).toBe("ready");
    cards = setAgentDeliveryState(cards, [metadata.runId], "integrating");
    expect(cards[0]?.status).toBe("integrating");
    cards = applyAgentEvent(cards, { type: "agent_integrated", runId: metadata.runId, handle: metadata.handle, parentSessionId: metadata.parentSessionId });
    expect(cards[0]?.status).toBe("integrated");
  });

  test("shows background cancellation as terminal without a pending delivery", () => {
    const metadata = agentMetadata();
    const cards = applyAgentEvent([agentCardFromMetadata(metadata)], {
      type: "agent_completed",
      result: {
        runId: metadata.runId,
        handle: metadata.handle,
        parentSessionId: metadata.parentSessionId,
        profileId: metadata.profileId,
        description: metadata.description,
        mode: "background",
        status: "cancelled",
        content: "SubAgent was cancelled.",
      },
    });
    expect(cards[0]).toMatchObject({ status: "cancelled" });
    expect(cards[0]?.delivery).toBeUndefined();
    expect(agentActivitySummary(cards)).toBeUndefined();
    expect(agentSidebarLines(cards, 28)[0]?.text).toBe("none active");
  });

  test("keeps active background work visible in the header and sidebar", () => {
    const cards = [card(), { ...card(), runId: "run-2", handle: "reviewer-1", status: "ready" as const, delivery: "pending" as const }];
    const summary = agentActivitySummary(cards);
    expect(summary).toBe("1 running · 1 ready");
    expect(headerLine("etl", 80, summary)).toContain("Agents 1 running · 1 ready");
    expect(agentSidebarLines(cards, 28).map((line) => line.text)).toEqual([
      "● explore-1 · running",
      "◆ reviewer-1 · ready",
    ]);
  });

  test("renders handle-based /agents detail without exposing the internal run id", () => {
    const metadata = { ...agentMetadata(), status: "completed" as const, result: "Mapped 42 sources." };
    const state = { ...agentCardFromMetadata(metadata), status: "integrated" as const };
    const detail = renderAgentDetail(metadata, state, []);
    expect(detail).toContain("SubAgent explore-1");
    expect(detail).toContain("Result: Mapped 42 sources.");
    expect(detail).not.toContain("run-1");
  });

  test("restores an Agent card at its original spawn position", () => {
    const state = card();
    const transcript = displayTranscriptFromSnapshot([
      {
        role: "assistant",
        content: "Delegating exploration.",
        toolCalls: [{ id: "call-1", name: "spawn_agent", arguments: "{}" }],
      },
      {
        role: "tool",
        content: "accepted",
        toolCallId: "call-1",
        toolOk: true,
      },
      { role: "assistant", content: "Parent continued." },
    ], [state]);
    expect(transcript.map((message) => message.kind ?? message.role)).toEqual([
      "assistant",
      "agent",
      "assistant",
    ]);
    expect(transcript[1]?.agentRunId).toBe("run-1");
  });

  test("restores background delivery as a host notice instead of raw model context", () => {
    const transcript = displayTranscriptFromSnapshot([{
      role: "user",
      kind: "subagent-results",
      content: '<subagent-results><agent id="explore-1">private packet</agent></subagent-results>',
    }]);
    expect(transcript).toEqual([{
      role: "system",
      content: "Background SubAgent results were delivered to the parent Engine.",
    }]);
  });

  test("retains observable background cards when switching parent sessions", () => {
    const running = card();
    const restored = { ...card(), runId: "run-2", handle: "plan-1", parentSessionId: "next" };
    const merged = mergeRestoredAgentCards([running], "next", [restored]);
    expect(merged.map((agent) => agent.runId)).toEqual(["run-1", "run-2"]);
    expect(agentSidebarLines(merged, 40, "next")[0]?.text).toContain("parked");
  });

  test("explicit delivery retry clears the pause before notifying the scheduler", async () => {
    const paused = new Set(["parent"]);
    let observedPaused = true;
    await retryAgentDelivery(paused, "parent", async (sessionId) => {
      expect(sessionId).toBe("parent");
      observedPaused = paused.has(sessionId);
    });
    expect(observedPaused).toBe(false);
    expect(paused.has("parent")).toBe(false);
  });
});

function card(): AgentCardState {
  return {
    runId: "run-1",
    handle: "explore-1",
    profileId: "explore",
    parentToolCallId: "call-1",
    parentSessionId: "parent",
    description: "Mapping source materials",
    mode: "background",
    status: "running",
    progress: "read_file · source_materials/chapter-12.md",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:12.000Z",
  };
}

function agentMetadata(): AgentMetadata {
  return {
    runId: "run-1",
    handle: "explore-1",
    profileId: "explore",
    description: "Mapping source materials",
    prompt: "Map sources.",
    mode: "background",
    parentSessionId: "parent",
    parentToolCallId: "call-1",
    status: "running",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:12.000Z",
  };
}
