
import { afterEach, describe, expect, test } from "bun:test";
import { resolveQualityDecision, runPrompt, type AgentLoopEvent } from "../../../src/core/agent-loop/run";
import { loadSessionSnapshot } from "../../../src/core/session/store";
import { createDecisionContinuations } from "../../../src/tui/decision-continuations";
import { harnessRuntime, restoreQualityTestState, runtimeRoot } from "./fixtures/quality-runtime";

afterEach(restoreQualityTestState);

describe("quality: tui decision continuation", () => {
  test("routes retry, accept, and stop through the real TUI decision continuation", async () => {
    for (const resolution of ["retry", "accept", "stop"] as const) {
      const root = await runtimeRoot("runtime");
      let requests = 0;
      globalThis.fetch = (async () => {
        requests += 1;
        return Response.json({
          id: `tui-${resolution}-${requests}`,
          choices: [{ message: { content: requests < 3 ? "空气中弥漫着雨味。" : "雨水顺着门轴滴到她的袖口。" } }],
        });
      }) as unknown as typeof fetch;
      const result = await runPrompt({
        input: "continue",
        engine: "runtime",
        rootDir: root,
        messages: [{ role: "user", content: "continue" }],
        harness: harnessRuntime(),
      });
      if (result.kind !== "needs_quality_decision") throw new Error("expected quality decision");
      const pending = { ...result, engine: "runtime" as const };
      const handled: unknown[] = [];
      const resumed: string[] = [];
      const pendingUpdates: unknown[] = [];
      const before = requests;
      const continuations = createDecisionContinuations({
        runtime: {
          busy: () => false,
          setBusy: (value: boolean) => value,
          activeProviderSelection: () => ({ provider: "test", model: "test-model" }),
          activeGeneration: () => undefined,
          permissionBroker: undefined as any,
        },
        session: { rootDir: root },
        transcript: {
          setStatus: (value: string) => value,
          setMessages: (value: unknown) => value,
          recordActivity: () => undefined,
        },
        decision: {
          pendingQualityDecision: () => pending,
          setPendingQualityDecision: (value: unknown) => { pendingUpdates.push(value); return value; },
          setQualitySelected: (value: number) => value,
        },
        agent: {
          agentManager: () => undefined as any,
          handleAgentEvent: () => undefined,
        },
        usage: { beginUsageTurn: () => undefined },
        hostAction: {
          refreshQualityWarnings: async () => undefined,
          resumeQualitySession: async (sessionId: string) => { resumed.push(sessionId); },
        },
        queuedWork: {
          block: () => undefined,
          release: () => undefined,
          handleInterruption: async () => false,
          takePendingUserInputs: () => [],
          runToolBoundaryCommands: async () => undefined,
        },
        runCancellable: async (operation: (signal: AbortSignal) => Promise<unknown>) => ({
          kind: "complete" as const,
          value: await operation(new AbortController().signal),
        }),
        handleResult: (value: unknown) => { handled.push(value); },
        handleInterruptedTurn: () => undefined,
        permissionContext: () => ({ mode: "MANUAL", shellExecEnabled: false, shellInterpreter: "auto" }),
        resolveQualityDecision: (options: any) => resolveQualityDecision({ ...options, harness: harnessRuntime() }),
        reportError: (error: unknown) => { throw error; },
      } as any);
      await continuations.submitQualityDecision(resolution);
      expect(pendingUpdates[0]).toBeNull();
      if (resolution === "retry") {
        expect(requests).toBe(before + 1);
        expect(handled.at(-1)).toMatchObject({ kind: "complete" });
      } else {
        expect(requests).toBe(before);
        expect(resumed).toEqual([result.sessionId]);
      }
    }
  });

  test("restores the TUI quality panel after retry cancellation or provider failure", async () => {
    for (const failure of ["cancel", "provider"] as const) {
      const root = await runtimeRoot("runtime");
      let requests = 0;
      globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
        requests += 1;
        if (requests <= 2) return Response.json({
          id: `tui-${failure}-${requests}`,
          choices: [{ message: { content: "空气中弥漫着雨味。" } }],
        });
        if (failure === "provider") throw new Error("quality retry provider failure");
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        });
      }) as unknown as typeof fetch;
      const result = await runPrompt({
        input: "continue",
        engine: "runtime",
        rootDir: root,
        messages: [{ role: "user", content: "continue" }],
        harness: harnessRuntime(),
      });
      if (result.kind !== "needs_quality_decision") throw new Error("expected quality decision");
      const pending = { ...result, engine: "runtime" as const };
      const pendingUpdates: unknown[] = [];
      const errors: unknown[] = [];
      const controller = new AbortController();
      const continuations = createDecisionContinuations({
        runtime: {
          busy: () => false,
          setBusy: (value: boolean) => value,
          activeProviderSelection: () => ({ provider: "test", model: "test-model" }),
          activeGeneration: () => undefined,
          permissionBroker: undefined as any,
        },
        session: { rootDir: root },
        transcript: {
          setStatus: (value: string) => value,
          setMessages: (value: unknown) => value,
          recordActivity: () => undefined,
        },
        decision: {
          pendingQualityDecision: () => pending,
          setPendingQualityDecision: (value: unknown) => { pendingUpdates.push(value); return value; },
          setQualitySelected: (value: number) => value,
        },
        agent: {
          agentManager: () => undefined as any,
          handleAgentEvent: (event: AgentLoopEvent) => {
            if (failure === "cancel" && event.type === "provider_request") controller.abort(new DOMException("cancel quality retry", "AbortError"));
          },
        },
        usage: { beginUsageTurn: () => undefined },
        hostAction: {
          refreshQualityWarnings: async () => undefined,
          resumeQualitySession: async () => undefined,
        },
        queuedWork: {
          block: () => undefined,
          release: () => undefined,
          handleInterruption: async () => false,
          takePendingUserInputs: () => [],
          runToolBoundaryCommands: async () => undefined,
        },
        runCancellable: async (operation: (signal: AbortSignal) => Promise<unknown>) => {
          try {
            return { kind: "complete" as const, value: await operation(controller.signal) };
          } catch (error) {
            if (controller.signal.aborted) return { kind: "interrupted" as const };
            throw error;
          }
        },
        handleResult: () => undefined,
        handleInterruptedTurn: () => undefined,
        permissionContext: () => ({ mode: "MANUAL", shellExecEnabled: false, shellInterpreter: "auto" }),
        resolveQualityDecision: (options: any) => resolveQualityDecision({ ...options, harness: harnessRuntime() }),
        reportError: (error: unknown) => { errors.push(error); },
      } as any);
      await continuations.submitQualityDecision("retry");
      expect(pendingUpdates[0]).toBeNull();
      expect(pendingUpdates.at(-1)).toMatchObject({ decision: { id: result.decision.id } });
      expect(errors).toHaveLength(failure === "provider" ? 1 : 0);
      const snapshot = await loadSessionSnapshot(root, result.sessionId, { synthesizeDanglingToolResults: false });
      expect(snapshot.pendingQualityDecision?.request.id).toBe(result.decision.id);
    }
  });

});
