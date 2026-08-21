import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { toVesicleMessage } from "../../../src/core/compact/summary-generator";
import { recordAssistantToolCalls } from "../../../src/core/agent-loop/assistant-recorder";
import { finalizeTurn } from "../../../src/core/agent-loop/turn-finalizer";
import { loadEngineProfile } from "../../../src/core/engine/profile";
import { createSessionStore, loadSessionRecords, loadSessionSnapshot } from "../../../src/core/session/store";
import { parseProviderStateEnvelope, type ProviderStateEnvelope } from "../../../src/providers/shared/state";
import { createPromptRoot } from "../agent-loop/fixtures/agent-loop";
import { createChildRunState, recordChildResponse, recordChildToolResult } from "../../../src/core/agents/child-run-durability";

function state(responseId: string): ProviderStateEnvelope {
  return {
    version: 1,
    protocol: "fixture-responses",
    providerId: "fixture-provider",
    model: "fixture-model",
    endpointFingerprint: "sha256:fixture-endpoint",
    payload: { responseId, outputItems: [{ type: "reasoning", encrypted_content: `encrypted-${responseId}` }] },
  };
}

describe("session provider-state projection", () => {
  test("child-Agent assistant responses retain state in memory and durable projection", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-provider-state-child-"));
    const store = await createSessionStore(rootDir, "provider-state-child");
    const child = createChildRunState([{ role: "user", content: "start" }]);

    await recordChildResponse(child, {
      id: "child-response",
      content: "child reply",
      webSearch: { provider: "fixture-provider", queries: ["child query"] },
      providerState: state("child-response"),
    }, store, "run-child", "child-1");

    expect(child.messages.at(-1)?.providerState).toEqual(state("child-response"));
    expect(child.messages.at(-1)?.webSearch?.queries).toEqual(["child query"]);
    const snapshot = await loadSessionSnapshot(rootDir, store.sessionId);
    expect(snapshot.messages.at(-1)?.providerState).toEqual(state("child-response"));
    expect(snapshot.messages.at(-1)?.webSearch?.queries).toEqual(["child query"]);
  });

  test("child-Agent failed tool results preserve the native error outcome", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-provider-state-child-tool-"));
    const store = await createSessionStore(rootDir, "provider-state-child-tool");
    const child = createChildRunState([{ role: "user", content: "start" }]);

    await recordChildToolResult(child, {
      call: { id: "call-failed", name: "shell_exec", arguments: "{}" },
      result: { callId: "call-failed", name: "shell_exec", ok: false, content: "exit 1" },
      session: store,
      runId: "run-child",
      handle: "child-1",
      profileId: "general",
      permissionMode: "MOMENTUM",
      decisionSource: "policy",
    });

    expect(child.messages.at(-1)).toMatchObject({ role: "tool", toolCallId: "call-failed", toolOk: false });
    expect((await loadSessionSnapshot(rootDir, store.sessionId)).messages.at(-1))
      .toMatchObject({ role: "tool", toolCallId: "call-failed", toolOk: false });
  });

  test("assistant recorders durably commit state for tool and final responses", async () => {
    const rootDir = await createPromptRoot();
    const profile = await loadEngineProfile("etl", rootDir);
    const store = await createSessionStore(rootDir, "provider-state-recorders");
    const messages = [{ role: "user" as const, content: "start" }];
    await store.append({ role: "system", content: "prompt" });
    await store.append({ role: "user", content: "start" });
    const call = { id: "call-state", name: "read_file", arguments: "{}" };

    await recordAssistantToolCalls({
      response: { id: "response-tool", content: "", toolCalls: [call], providerState: state("response-tool") },
      toolCalls: [call],
      messages,
      session: store,
      profile,
      model: "fixture-model",
    });
    await store.append({ role: "tool", content: "fixture", metadata: { toolCallId: call.id, ok: true } });
    await finalizeTurn({
      response: { id: "response-final", content: "done", providerState: state("response-final") },
      messages,
      session: store,
      profile,
      model: "fixture-model",
    });

    const records = await loadSessionRecords(rootDir, store.sessionId);
    const assistantStates = records
      .filter((record) => record.role === "assistant")
      .map((record) => parseProviderStateEnvelope(record.metadata?.providerState));
    expect(assistantStates).toEqual([state("response-tool"), state("response-final")]);
    const snapshot = await loadSessionSnapshot(rootDir, store.sessionId);
    expect(snapshot.messages.filter((message) => message.role === "assistant").map((message) => message.providerState)).toEqual(assistantStates);
  });

  test("preserves opaque state across load, resume conversion, rewind, and append-only branching", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-provider-state-"));
    const store = await createSessionStore(rootDir, "provider-state-session");
    await store.append({ role: "system", content: "prompt" });
    const user = await store.append({ role: "user", content: "first" });
    const first = await store.append({ role: "assistant", content: "first reply", metadata: { providerState: state("response-a") } });

    const branch = await createSessionStore(rootDir, store.sessionId, { parentUuid: user.uuid });
    const second = await branch.append({ role: "assistant", content: "branched reply", metadata: { providerState: state("response-b") } });

    const active = await loadSessionSnapshot(rootDir, store.sessionId);
    expect(active.headUuid).toBe(second.uuid);
    expect(active.messages.at(-1)?.providerState).toEqual(state("response-b"));
    const resumed = toVesicleMessage(active.messages.at(-1)!);
    expect(resumed.providerState).toEqual(state("response-b"));
    expect(resumed.providerState).not.toBe(active.messages.at(-1)?.providerState);

    const rewound = await loadSessionSnapshot(rootDir, store.sessionId, { headUuid: first.uuid });
    expect(rewound.messages.at(-1)?.providerState).toEqual(state("response-a"));
    const payload = rewound.messages.at(-1)?.providerState?.payload as { responseId: string };
    payload.responseId = "mutated-in-memory";
    const reloaded = await loadSessionSnapshot(rootDir, store.sessionId, { headUuid: first.uuid });
    const reloadedPayload = reloaded.messages.at(-1)?.providerState?.payload;
    if (!reloadedPayload || typeof reloadedPayload !== "object" || Array.isArray(reloadedPayload)) {
      throw new Error("expected reloaded provider state payload");
    }
    expect(reloadedPayload.responseId).toBe("response-a");
  });

  test("preserves host-only message kinds when rebuilding provider requests", () => {
    expect(toVesicleMessage({ role: "user", content: "", kind: "provider-native-checkpoint" }))
      .toMatchObject({ role: "user", content: "", kind: "provider-native-checkpoint" });
  });

  test("fails session load on unsupported or malformed required provider state", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-provider-state-invalid-"));
    const store = await createSessionStore(rootDir, "provider-state-invalid");
    await store.append({ role: "system", content: "prompt" });
    await store.append({ role: "assistant", content: "reply", metadata: { providerState: { ...state("bad"), version: 2 } } });
    await expect(loadSessionSnapshot(rootDir, store.sessionId)).rejects.toThrow(/version 2 is not supported/);
  });

  test("restores provider state inside a pending Quality candidate", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-provider-state-quality-"));
    const store = await createSessionStore(rootDir, "provider-state-quality");
    const candidateState = state("quality-candidate");
    await store.append({
      role: "system",
      content: "",
      metadata: {
        kind: "quality-check-pending",
        qualityRewrite: {
          producer: "runtime",
          packId: "fixture-pack",
          packVersion: "1.0.0",
          manifestSha256: "a".repeat(64),
          ruleVersion: "1",
          ruleSourceHash: "b".repeat(64),
          attempts: 1,
          rejectedHashes: [],
          candidateParts: [],
          targets: [],
          candidate: {
            responseId: "quality-candidate",
            content: "candidate",
            toolCalls: [],
            providerState: candidateState,
          },
        },
      },
    });

    const snapshot = await loadSessionSnapshot(rootDir, store.sessionId, { synthesizeDanglingToolResults: false });
    expect(snapshot.pendingQualityRewrite?.candidate?.providerState).toEqual(candidateState);
    expect(snapshot.pendingQualityRewrite?.candidate?.providerState).not.toBe(candidateState);
  });
});
