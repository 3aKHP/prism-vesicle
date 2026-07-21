import { mkdtemp, } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { createSessionStore, loadSessionSnapshot } from "../../../src/core/session/store";

describe("session: provider selection recovery", () => {
  test("loadSessionSnapshot restores the latest provider/model selection", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-provider-session-"));
    const store = await createSessionStore(rootDir, "2026-05-01T00-00-00-000Z-provider");

    await store.append({
      role: "system",
      content: "prompt",
      metadata: { providerId: "deepseek", model: "deepseek-v4-flash" },
    });
    await store.append({
      role: "user",
      content: "first",
      metadata: { providerId: "deepseek", model: "deepseek-v4-flash" },
    });
    await store.append({
      role: "user",
      content: "second",
      metadata: { providerId: "local", model: "qwen3" },
    });

    const snapshot = await loadSessionSnapshot(rootDir, "2026-05-01T00-00-00-000Z-provider");

    expect(snapshot.providerSelection).toEqual({ provider: "local", model: "qwen3" });
  });

  test("loadSessionSnapshot restores the latest engine selection", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-engine-session-"));
    const store = await createSessionStore(rootDir, "2026-05-01T00-00-00-000Z-engine");

    await store.append({
      role: "system",
      content: "prompt",
      metadata: { engine: "etl" },
    });
    await store.append({
      role: "system",
      content: "Engine switched to runtime.",
      metadata: { kind: "engine-switch", engine: "runtime" },
    });
    await store.append({
      role: "user",
      content: "continue",
      metadata: { engine: "weaver-orch" },
    });

    const snapshot = await loadSessionSnapshot(rootDir, "2026-05-01T00-00-00-000Z-engine");

    expect(snapshot.engine).toBe("weaver-orch");
  });

  test("loadSessionSnapshot ignores unknown engine metadata", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-engine-invalid-session-"));
    const store = await createSessionStore(rootDir, "2026-05-01T00-00-00-000Z-engine-invalid");

    await store.append({
      role: "system",
      content: "prompt",
      metadata: { engine: "not-real" },
    });

    const snapshot = await loadSessionSnapshot(rootDir, "2026-05-01T00-00-00-000Z-engine-invalid");

    expect(snapshot.engine).toBeUndefined();
  });

  test("loadSessionSnapshot restores the latest thinking tier", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-thinking-session-"));
    const store = await createSessionStore(rootDir, "2026-05-01T00-00-00-000Z-thinking");

    await store.append({ role: "system", content: "prompt" });
    await store.append({
      role: "system",
      content: "Thinking effort switched to low.",
      metadata: { kind: "thinking-switch", reasoningTier: "low" },
    });
    await store.append({
      role: "user",
      content: "second",
      metadata: { reasoningTier: "max" },
    });

    const snapshot = await loadSessionSnapshot(rootDir, "2026-05-01T00-00-00-000Z-thinking");

    expect(snapshot.reasoningTier).toBe("max");
  });

  test("loadSessionSnapshot restores cleared thinking tier as provider default", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-thinking-clear-session-"));
    const store = await createSessionStore(rootDir, "2026-05-01T00-00-00-000Z-thinking-clear");

    await store.append({ role: "system", content: "prompt" });
    await store.append({
      role: "system",
      content: "Thinking effort switched to max.",
      metadata: { kind: "thinking-switch", reasoningTier: "max" },
    });
    await store.append({
      role: "system",
      content: "Thinking effort reset to provider default.",
      metadata: { kind: "thinking-switch", reasoningTier: null },
    });

    const snapshot = await loadSessionSnapshot(rootDir, "2026-05-01T00-00-00-000Z-thinking-clear");

    expect(snapshot.reasoningTier).toBeUndefined();
  });

  test("loadSessionSnapshot restores the latest reasoning display mode", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-reasoning-display-session-"));
    const store = await createSessionStore(rootDir, "2026-05-01T00-00-00-000Z-reasoning-display");

    await store.append({ role: "system", content: "prompt" });
    await store.append({
      role: "system",
      content: "Reasoning display switched to hidden.",
      metadata: { kind: "reasoning-switch", reasoningDisplayMode: "hidden" },
    });
    await store.append({
      role: "system",
      content: "Reasoning display switched to expanded.",
      metadata: { kind: "reasoning-switch", reasoningDisplayMode: "expanded" },
    });

    const snapshot = await loadSessionSnapshot(rootDir, "2026-05-01T00-00-00-000Z-reasoning-display");

    expect(snapshot.reasoningDisplayMode).toBe("expanded");
  });

});
