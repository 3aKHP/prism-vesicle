import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  COMPACT_CHECKPOINT_KIND,
  createSessionStore,
  loadSessionMessages,
} from "../../../src/core/session/store";
import type { PortableCompactCheckpointV1 } from "../../../src/core/session/store";
import { PROVIDER_NATIVE_CHECKPOINT_KIND } from "../../../src/providers/shared/types";

function validCheckpoint(overrides: Partial<PortableCompactCheckpointV1> = {}): PortableCompactCheckpointV1 {
  return {
    version: 1,
    strategy: "portable-summary",
    trigger: "manual",
    phase: "manual",
    reason: "requested",
    sourceHeadUuid: crypto.randomUUID(),
    createdWith: { providerId: "test", model: "test-model", engine: "etl" },
    replacementMessages: [{ role: "user", content: "[conversation summary]\nEarlier work.", kind: "compact-summary" }],
    summary: { text: "Earlier work.", evictedLogicalTurnIds: ["t0"], evictedProviderRoundIds: ["r0"] },
    retained: { logicalTurnIds: [], providerRoundIds: [] },
    accounting: { beforeSource: "unknown" },
    ...overrides,
  };
}

describe("session: compact-checkpoint-v1 projection", () => {
  test("a valid checkpoint resets history to its replacement and replays the suffix", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-ckpt-"));
    const store = await createSessionStore(rootDir, "ckpt-session");
    await store.append({ role: "system", content: "composed prompt", metadata: { engine: "etl" } });
    await store.append({ role: "user", content: "old prompt", metadata: { logicalTurnId: "t0", providerRoundId: "r0" } });
    await store.append({ role: "assistant", content: "old reply", metadata: { logicalTurnId: "t0", providerRoundId: "r0" } });
    await store.append({
      role: "system",
      content: "Conversation compacted.",
      metadata: { kind: COMPACT_CHECKPOINT_KIND, checkpoint: validCheckpoint() },
    });
    await store.append({ role: "user", content: "after compact", metadata: { logicalTurnId: "t1", providerRoundId: "r1" } });
    await store.append({ role: "assistant", content: "after reply", metadata: { logicalTurnId: "t1", providerRoundId: "r1" } });

    const messages = await loadSessionMessages(rootDir, store.sessionId);
    // The evicted prefix is gone; the checkpoint replacement is followed by the
    // exact suffix recorded after it.
    expect(messages.map((message) => message.content)).toEqual([
      "[conversation summary]\nEarlier work.",
      "after compact",
      "after reply",
    ]);
  });

  test("retained assistant messages preserve bounded provider state", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-ckpt-provider-state-"));
    const store = await createSessionStore(rootDir, "ckpt-provider-state");
    const providerState = {
      version: 1 as const,
      protocol: "fixture-responses",
      providerId: "fixture-provider",
      model: "fixture-model",
      endpointFingerprint: "sha256:fixture-endpoint",
      payload: { responseId: "response-retained", outputItems: [] },
    };
    await store.append({ role: "system", content: "prompt", metadata: { engine: "etl" } });
    await store.append({
      role: "system",
      content: "compacted",
      metadata: {
        kind: COMPACT_CHECKPOINT_KIND,
        checkpoint: validCheckpoint({
          replacementMessages: [
            { role: "user", content: "[conversation summary]\nEarlier work.", kind: "compact-summary" },
            { role: "assistant", content: "retained", providerState },
          ],
        }),
      },
    });

    const messages = await loadSessionMessages(rootDir, store.sessionId);
    expect(messages[1]?.providerState).toEqual(providerState);
    expect(messages[1]?.providerState).not.toBe(providerState);
  });

  test("retained assistant messages preserve built-in search audit data", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-ckpt-web-search-"));
    const store = await createSessionStore(rootDir, "ckpt-web-search");
    const webSearch = {
      provider: "fixture-provider",
      queries: ["retained query"],
      citations: [{ url: "https://example.com/source", title: "Source" }],
      calls: [{ id: "search-1", status: "completed", action: { type: "search", query: "retained query" } }],
    };
    await store.append({ role: "system", content: "prompt", metadata: { engine: "etl" } });
    await store.append({
      role: "system",
      content: "compacted",
      metadata: {
        kind: COMPACT_CHECKPOINT_KIND,
        checkpoint: validCheckpoint({
          replacementMessages: [
            { role: "user", content: "[conversation summary]\nEarlier work.", kind: "compact-summary" },
            { role: "assistant", content: "retained", webSearch },
          ],
        }),
      },
    });

    const messages = await loadSessionMessages(rootDir, store.sessionId);
    expect(messages[1]?.webSearch).toEqual(webSearch);
  });

  test("rejects a retained assistant web-search report without its query audit floor", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-ckpt-web-search-invalid-"));
    const store = await createSessionStore(rootDir, "ckpt-web-search-invalid");
    await store.append({ role: "system", content: "prompt", metadata: { engine: "etl" } });
    await store.append({
      role: "system",
      content: "compacted",
      metadata: {
        kind: COMPACT_CHECKPOINT_KIND,
        checkpoint: validCheckpoint({
          replacementMessages: [
            { role: "user", content: "[conversation summary]\nEarlier work.", kind: "compact-summary" },
            { role: "assistant", content: "retained", webSearch: { provider: "fixture", queries: [] } },
          ],
        }),
      },
    });

    await expect(loadSessionMessages(rootDir, store.sessionId)).rejects.toThrow("webSearch is malformed");
  });

  test("projects an owner-bound native marker after the portable replacement", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-ckpt-native-"));
    const store = await createSessionStore(rootDir, "ckpt-native");
    const sourceHeadUuid = crypto.randomUUID();
    const providerState = {
      version: 1 as const,
      protocol: "openai-responses",
      providerId: "openai",
      model: "gpt-5.6",
      endpointFingerprint: "sha256:fixture-endpoint",
      payload: { version: 1, compactedInput: [{ type: "compaction", encrypted_content: "opaque" }] },
    };
    await store.append({ role: "system", content: "prompt", metadata: { engine: "etl" } });
    await store.append({
      role: "system",
      content: "compacted",
      metadata: {
        kind: COMPACT_CHECKPOINT_KIND,
        checkpoint: validCheckpoint({
          sourceHeadUuid,
          nativeProjection: { sourceHeadUuid, state: providerState },
        }),
      },
    });

    const messages = await loadSessionMessages(rootDir, store.sessionId);
    expect(messages.map((message) => message.kind)).toEqual(["compact-summary", PROVIDER_NATIVE_CHECKPOINT_KIND]);
    expect(messages[1]).toMatchObject({ role: "user", content: "", providerState });
    expect(messages[1]?.providerState).not.toBe(providerState);
  });

  test("rejects a native projection derived from a different source head", async () => {
    const checkpoint = validCheckpoint();
    checkpoint.nativeProjection = {
      sourceHeadUuid: crypto.randomUUID(),
      state: {
        version: 1,
        protocol: "openai-responses",
        providerId: "openai",
        model: "gpt-5.6",
        endpointFingerprint: "sha256:fixture-endpoint",
        payload: { version: 1, compactedInput: [] },
      },
    };
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-ckpt-native-source-"));
    const store = await createSessionStore(rootDir, "ckpt-native-source");
    await store.append({ role: "system", content: "prompt" });
    await store.append({
      role: "system",
      content: "compacted",
      metadata: { kind: COMPACT_CHECKPOINT_KIND, checkpoint },
    });
    await expect(loadSessionMessages(rootDir, store.sessionId)).rejects.toThrow("source head does not match");
  });

  test("drops a corrupt optional native envelope while keeping the portable projection readable", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-ckpt-native-corrupt-"));
    const store = await createSessionStore(rootDir, "ckpt-native-corrupt");
    const sourceHeadUuid = crypto.randomUUID();
    await store.append({ role: "system", content: "prompt" });
    await store.append({
      role: "system",
      content: "compacted",
      metadata: {
        kind: COMPACT_CHECKPOINT_KIND,
        checkpoint: validCheckpoint({
          sourceHeadUuid,
          nativeProjection: {
            sourceHeadUuid,
            state: {
              version: 99 as 1,
              protocol: "openai-responses",
              providerId: "openai",
              model: "gpt-5.6",
              endpointFingerprint: "sha256:fixture-endpoint",
              payload: { version: 1, compactedInput: [] },
            },
          },
        }),
      },
    });

    const messages = await loadSessionMessages(rootDir, store.sessionId);
    expect(messages.map((message) => message.kind)).toEqual(["compact-summary"]);
    expect(messages[0]?.content).toBe("[conversation summary]\nEarlier work.");
  });

  test("an unknown future checkpoint version fails with an actionable error instead of partially projecting", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-ckpt-unknown-"));
    const store = await createSessionStore(rootDir, "ckpt-unknown");
    await store.append({ role: "system", content: "prompt", metadata: { engine: "etl" } });
    await store.append({ role: "user", content: "old" });
    await store.append({
      role: "system",
      content: "compacted",
      metadata: { kind: COMPACT_CHECKPOINT_KIND, checkpoint: validCheckpoint({ version: 99 as unknown as 1 }) },
    });

    await expect(loadSessionMessages(rootDir, store.sessionId)).rejects.toThrow(/not supported/);
  });

  test("a malformed v1 checkpoint fails instead of partially projecting", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-ckpt-malformed-"));
    const store = await createSessionStore(rootDir, "ckpt-malformed");
    await store.append({ role: "system", content: "prompt", metadata: { engine: "etl" } });
    await store.append({ role: "user", content: "old" });
    const malformed = validCheckpoint();
    // Corrupt the replacement list so validation rejects the whole payload.
    (malformed as unknown as { replacementMessages: unknown }).replacementMessages = [{ role: "user" /* missing content */ }];
    await store.append({
      role: "system",
      content: "compacted",
      metadata: { kind: COMPACT_CHECKPOINT_KIND, checkpoint: malformed },
    });

    await expect(loadSessionMessages(rootDir, store.sessionId)).rejects.toThrow(/replacementMessages|malformed/);
  });

  test("replacement messages fail closed on invalid roles and nested provider fields", async () => {
    const summaryMessage: PortableCompactCheckpointV1["replacementMessages"][number] = {
      role: "user",
      content: "[conversation summary]\nEarlier work.",
      kind: "compact-summary",
    };
    const invalidMessages: unknown[] = [
      { role: "bogus", content: "invalid role" },
      { role: "assistant", content: "invalid calls", toolCalls: [{ id: "call", name: "read_file" }] },
      { role: "user", content: "assistant-only field", toolCalls: [] },
      { role: "tool", content: "missing tool call id", toolOk: true },
      {
        role: "user",
        content: "invalid image",
        images: [{
          id: "img_bad",
          path: "../../outside.png",
          mediaType: "image/png",
          bytes: 1,
          sha256: "a".repeat(64),
          source: "clipboard",
        }],
      },
      {
        role: "user",
        content: "prefixed traversal image",
        images: [{
          id: "img_bad",
          path: ".vesicle/attachments/../../outside.png",
          mediaType: "image/png",
          bytes: 1,
          sha256: "a".repeat(64),
          source: "clipboard",
        }],
      },
      {
        role: "user",
        content: "standalone traversal image",
        images: [{
          id: "img_bad",
          path: ".vesicle/attachments/..",
          mediaType: "image/png",
          bytes: 1,
          sha256: "a".repeat(64),
          source: "clipboard",
        }],
      },
    ];

    for (const [index, replacement] of invalidMessages.entries()) {
      const rootDir = await mkdtemp(join(tmpdir(), `vesicle-ckpt-deep-${index}-`));
      const store = await createSessionStore(rootDir, `ckpt-deep-${index}`);
      await store.append({ role: "system", content: "prompt", metadata: { engine: "etl" } });
      await store.append({
        role: "system",
        content: "compacted",
        metadata: {
          kind: COMPACT_CHECKPOINT_KIND,
          checkpoint: validCheckpoint({
            replacementMessages: [summaryMessage, replacement] as PortableCompactCheckpointV1["replacementMessages"],
          }),
        },
      });
      await expect(loadSessionMessages(rootDir, store.sessionId)).rejects.toThrow(/replacementMessages|malformed/);
    }
  });

  test("a failed turn after a checkpoint drops only the failed input, preserving the replacement", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-ckpt-failed-"));
    const store = await createSessionStore(rootDir, "ckpt-failed");
    const sourceHeadUuid = crypto.randomUUID();
    const providerState = {
      version: 1 as const,
      protocol: "openai-responses",
      providerId: "openai",
      model: "gpt-5.6",
      endpointFingerprint: "sha256:fixture-endpoint",
      payload: { version: 1, compactedInput: [{ type: "compaction", encrypted_content: "opaque" }] },
    };
    await store.append({ role: "system", content: "prompt", metadata: { engine: "etl" } });
    await store.append({
      role: "system",
      content: "compacted",
      metadata: {
        kind: COMPACT_CHECKPOINT_KIND,
        checkpoint: validCheckpoint({
          sourceHeadUuid,
          nativeProjection: { sourceHeadUuid, state: providerState },
        }),
      },
    });
    await store.append({ role: "user", content: "failed prompt", metadata: { logicalTurnId: "t1", providerRoundId: "r1" } });
    await store.append({ role: "system", content: "", metadata: { kind: "failed-turn" } });

    const messages = await loadSessionMessages(rootDir, store.sessionId);
    // The checkpoint's replacement (a completed-operation boundary) survives;
    // only the failed turn's trailing input is dropped.
    expect(messages.map((message) => message.kind)).toEqual(["compact-summary", PROVIDER_NATIVE_CHECKPOINT_KIND]);
    expect(messages[1]).toMatchObject({ content: "", providerState });
  });

  test("image attachments in the replacement history stay reachable through projection", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-ckpt-images-"));
    const store = await createSessionStore(rootDir, "ckpt-images");
    await store.append({ role: "system", content: "prompt", metadata: { engine: "etl" } });
    const image = { id: "img_reachable", path: ".vesicle/attachments/img_reachable.png", mediaType: "image/png" as const, bytes: 12, sha256: "a".repeat(64), source: "mcp" as const };
    await store.append({
      role: "system",
      content: "compacted",
      metadata: {
        kind: COMPACT_CHECKPOINT_KIND,
        checkpoint: validCheckpoint({
          replacementMessages: [
            { role: "user", content: "[conversation summary]\nEarlier work.", kind: "compact-summary" },
            { role: "user", content: "kept turn with an image", images: [image] },
          ],
          retained: { logicalTurnIds: ["t1"], providerRoundIds: ["r1"] },
        }),
      },
    });

    const messages = await loadSessionMessages(rootDir, store.sessionId);
    // The retained tail's attachment reference survives projection verbatim, so
    // any reachability/GC scan of the provider-visible history still sees it.
    expect(messages.map((message) => message.content)).toEqual([
      "[conversation summary]\nEarlier work.",
      "kept turn with an image",
    ]);
    expect(messages[1]!.images).toEqual([image]);
  });

  test("toolSkillEvent in the retained tail survives checkpoint round-trip", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-ckpt-skill-"));
    const store = await createSessionStore(rootDir, "ckpt-skill");
    await store.append({ role: "system", content: "prompt", metadata: { engine: "etl" } });
    const skillEvent = { kind: "skill_resource_read", name: "vesicle-docs", path: "references/root-readme.md", bytes: 4096, truncated: false } as const;
    await store.append({
      role: "system",
      content: "compacted",
      metadata: {
        kind: COMPACT_CHECKPOINT_KIND,
        checkpoint: validCheckpoint({
          replacementMessages: [
            { role: "user", content: "[conversation summary]\nEarlier work.", kind: "compact-summary" },
            { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "read_skill_resource", arguments: "{}" }] },
            { role: "tool", content: "# Prism Vesicle", toolCallId: "call_1", toolOk: true, toolSkillEvent: skillEvent },
          ],
          retained: { logicalTurnIds: ["t1"], providerRoundIds: ["r1"] },
        }),
      },
    });

    const messages = await loadSessionMessages(rootDir, store.sessionId);
    expect(messages).toHaveLength(3);
    const toolMessage = messages[2]!;
    expect(toolMessage.role).toBe("tool");
    expect((toolMessage as Record<string, unknown>).toolSkillEvent).toEqual(skillEvent);
  });
});
