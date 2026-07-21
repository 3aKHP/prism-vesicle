import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { runPrompt, type AgentLoopEvent } from "../../../src/core/agent-loop/run";
import { completeProviderRound } from "../../../src/core/agent-loop/provider-round";
import { runChildAgent } from "../../../src/core/agents/child-runner";
import { getProcessManager } from "../../../src/core/process/manager";
import { createSessionStore, loadSessionRecords, loadSessionSnapshot } from "../../../src/core/session/store";
import { baseRoot, childContext, childRoot, harnessRuntime, providerTool, restoreQualityTestState, runtimeRoot } from "./fixtures/quality-runtime";

afterEach(restoreQualityTestState);

describe("quality: engine and child observe", () => {
  test("persists every declared Engine observe path and excludes Evaluate analyze output", async () => {
    for (const engine of ["dyad", "weaver", "weaver-orch", "evaluate"] as const) {
      const root = await runtimeRoot(engine);
      let requests = 0;
      globalThis.fetch = (async () => {
        requests += 1;
        const content = engine === "dyad"
          ? "### Part 3 — Prose Content\n空气中弥漫着旧纸味。\n\n### Part 4 — HUD\n[State] stable\n\n### Part 3 — Prose Content\n她把旧纸压进抽屉。"
          : "空气中弥漫着旧纸味。";
        return Response.json({ id: engine, choices: [{ message: { content } }] });
      }) as unknown as typeof fetch;
      const result = await runPrompt({
        input: "draft",
        engine,
        rootDir: root,
        messages: [{ role: "user", content: "draft" }],
        harness: harnessRuntime(),
      });
      expect(result.kind).toBe("complete");
      expect(requests).toBe(1);
      const snapshot = await loadSessionSnapshot(root, result.sessionId);
      if (engine === "evaluate") expect(snapshot.qualityEvents).toEqual([]);
      else expect(snapshot.qualityEvents).toEqual([expect.objectContaining({
        producer: engine,
        mode: "observe",
        decision: "observe",
        findingIds: ["zh-f0-air-thick-with"],
      })]);
    }
  });

  test("observes successful artifact prose instead of tool-call planning text", async () => {
    const root = await runtimeRoot("weaver");
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      if (requests === 1) {
        const response = await providerTool("weaver-clean-scene", "write_file", {
          path: "workspace/Scene_001.md",
          content: "雨滴沿着窗框滑到她的指节。",
        }).json() as any;
        response.choices[0].message.content = "空气中弥漫着计划中的旧例。";
        return Response.json(response);
      }
      return Response.json({ id: "weaver-done", choices: [{ message: { content: "Scene written." } }] });
    }) as unknown as typeof fetch;
    const result = await runPrompt({
      input: "write",
      engine: "weaver",
      rootDir: root,
      messages: [{ role: "user", content: "write" }],
      harness: harnessRuntime(),
    });
    const snapshot = await loadSessionSnapshot(root, result.sessionId);
    expect(snapshot.qualityEvents).toEqual([expect.objectContaining({ decision: "pass", findingIds: [] })]);
  });

  test("observes Scene Writer before child completion and excludes Chapter Reviewer analyze output", async () => {
    const root = await childRoot();
    let responseContent = "空气中弥漫着旧木头味。";
    globalThis.fetch = (async () => Response.json({ id: "child", choices: [{ message: { content: responseContent } }] })) as unknown as typeof fetch;

    const scene = await runChildAgent(childContext(root, "scene-writer"));
    const sceneRecords = await loadSessionRecords(root, scene.childSessionId!);
    const qualityIndex = sceneRecords.findIndex((record) => record.metadata?.kind === "quality-event");
    expect(qualityIndex).toBeGreaterThan(0);
    expect(sceneRecords[qualityIndex]!.metadata?.qualityEvent).toMatchObject({ producer: "scene-writer", decision: "observe" });

    responseContent = "空气中弥漫着报告里的旧例。";
    const reviewer = await runChildAgent(childContext(root, "chapter-reviewer"));
    const reviewerRecords = await loadSessionRecords(root, reviewer.childSessionId!);
    expect(reviewerRecords.some((record) => record.metadata?.kind === "quality-event")).toBe(false);

    let childRequests = 0;
    globalThis.fetch = (async () => {
      childRequests += 1;
      if (childRequests === 1) {
        const response = await providerTool("child-clean-scene", "write_file", {
          path: "workspace/Scene_002.md",
          content: "她把湿透的袖口卷到肘上。",
        }).json() as any;
        response.choices[0].message.content = "空气中弥漫着计划里的旧例。";
        return Response.json(response);
      }
      return Response.json({ id: "child-done", choices: [{ message: { content: "Scene written." } }] });
    }) as unknown as typeof fetch;
    const artifactScene = await runChildAgent(childContext(root, "scene-writer"));
    const artifactRecords = await loadSessionRecords(root, artifactScene.childSessionId!);
    expect(artifactRecords.find((record) => record.metadata?.kind === "quality-event")?.metadata?.qualityEvent)
      .toMatchObject({ producer: "scene-writer", decision: "pass", findingIds: [] });

    await writeFile(
      join(root, "workspace", "Scene_003.md"),
      "空气中弥漫着雨味。\n空气中弥漫着尘味。",
      "utf8",
    );
    childRequests = 0;
    globalThis.fetch = (async () => {
      childRequests += 1;
      if (childRequests === 1) {
        return providerTool("child-partial-scene", "replace_in_file", {
          path: "workspace/Scene_003.md",
          oldText: "空气中弥漫着雨味。",
          newText: "雨水沿着门框滑落。",
        });
      }
      return Response.json({ id: "child-partial-done", choices: [{ message: { content: "Scene revised." } }] });
    }) as unknown as typeof fetch;
    const partialScene = await runChildAgent(childContext(root, "scene-writer"));
    const partialRecords = await loadSessionRecords(root, partialScene.childSessionId!);
    expect(partialRecords.find((record) => record.metadata?.kind === "quality-event")?.metadata?.qualityEvent)
      .toMatchObject({ producer: "scene-writer", decision: "observe", findingIds: ["zh-f0-air-thick-with"] });
  });

  test("buffers streamed prose while rewrite enforcement is active", async () => {
    const root = await baseRoot();
    const session = await createSessionStore(root, "buffered");
    await session.append({ role: "system", content: "system" });
    const events: AgentLoopEvent[] = [];
    const provider = {
      id: "fixture",
      complete: async () => ({ id: "unused", content: "unused" }),
      async *stream() {
        yield { type: "content_delta" as const, delta: "空气中弥漫着" };
        yield { type: "complete" as const, response: { id: "streamed", content: "空气中弥漫着雨味。" } };
      },
    };
    const response = await completeProviderRound({
      rootDir: root,
      provider,
      providerId: "fixture",
      model: "fixture",
      visionEnabled: false,
      systemPrompt: "system",
      tools: [],
      messages: [{ role: "user", content: "continue" }],
      session,
      processManager: getProcessManager(root),
      iteration: 0,
      bufferAssistant: true,
      onEvent: (event) => events.push(event),
    });
    expect(response.content).toContain("空气中弥漫着");
    expect(events.some((event) => event.type === "assistant_delta")).toBe(false);
  });

});
