import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VesicleConfig } from "../../../src/config/env";
import type { ProviderAdapter } from "../../../src/providers/shared/types";
import {
  appendSessionTitle,
  createSessionStore,
  loadSessionRecords,
  maybeGenerateSessionTitle,
  projectSessionHistory,
  projectSessionTitle,
  projectSessionTitleGeneration,
  projectSessionTitleUsage,
  resetSessionTitleGeneration,
} from "../../../src/core/session/store";

async function fixture() {
  const rootDir = await mkdtemp(join(tmpdir(), "vesicle-session-title-"));
  const configDir = join(rootDir, "config");
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "settings.yaml"), "version: 1\nsessionTitle: auto\n", "utf8");
  const session = await createSessionStore(rootDir, "title-test");
  await session.append({ role: "system", content: "system" });
  const user = await session.append({ role: "user", content: "Plan a terminal title feature" });
  const assistant = await session.append({ role: "assistant", content: "Implemented the durable title behavior." });
  const config = { providerId: "test", model: "fixture-model" } as VesicleConfig;
  const env = { NODE_ENV: "test", VESICLE_CONFIG_DIR: configDir };
  return { rootDir, session, user, assistant, config, env };
}

describe("durable session title lifecycle", () => {
  test("generates from the first complete turn and keeps metadata out of provider history", async () => {
    const f = await fixture();
    const provider: ProviderAdapter = {
      id: "fixture",
      complete: async () => ({ id: "title-response", content: "Terminal Title Planning", usage: { inputTokens: 12, outputTokens: 4, reasoningTokens: 2 } }),
    };
    await maybeGenerateSessionTitle({ ...f, provider });
    const records = await loadSessionRecords(f.rootDir, f.session.sessionId);
    expect(projectSessionTitle(records)).toEqual({
      title: "Terminal Title Planning",
      source: "generated",
      firstUserUuid: f.user.uuid,
      firstAssistantUuid: f.assistant.uuid,
    });
    expect(projectSessionTitleGeneration(records)).toMatchObject({ attempts: 1, settled: true, retryable: false });
    expect(projectSessionTitleUsage(records)).toEqual([{ inputTokens: 12, outputTokens: 4, reasoningTokens: 2 }]);
    expect(projectSessionHistory(records).messages.map((message) => message.content)).toEqual([
      "Plan a terminal title feature",
      "Implemented the durable title behavior.",
    ]);
  });

  test("manual rename prevents a later automatic request", async () => {
    const f = await fixture();
    await appendSessionTitle(f.rootDir, f.session.sessionId, "My title", "user");
    let calls = 0;
    const provider: ProviderAdapter = { id: "fixture", complete: async () => { calls += 1; return { id: "unexpected", content: "Generated" }; } };
    await maybeGenerateSessionTitle({ ...f, provider });
    expect(calls).toBe(0);
    expect(projectSessionTitle(await loadSessionRecords(f.rootDir, f.session.sessionId))?.source).toBe("user");
  });

  test("regenerate aborts an in-flight request without restoring its stale claim", async () => {
    const f = await fixture();
    let started!: () => void;
    const providerStarted = new Promise<void>((resolve) => { started = resolve; });
    const provider: ProviderAdapter = {
      id: "fixture",
      complete: async (request) => {
        started();
        return new Promise((_resolve, reject) => request.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
      },
    };
    const pending = maybeGenerateSessionTitle({ ...f, provider });
    await providerStarted;
    await resetSessionTitleGeneration(f.rootDir, f.session.sessionId);
    await pending;
    expect(projectSessionTitleGeneration(await loadSessionRecords(f.rootDir, f.session.sessionId))).toEqual({ attempts: 0, settled: false });
  });

  test("reset scopes active requests by project root when session ids match", async () => {
    const first = await fixture();
    const second = await fixture();
    let firstStarted!: () => void;
    let secondStarted!: () => void;
    let firstAborted = false;
    let secondAborted = false;
    const firstReady = new Promise<void>((resolve) => { firstStarted = resolve; });
    const secondReady = new Promise<void>((resolve) => { secondStarted = resolve; });
    const provider = (started: () => void, markAborted: () => void): ProviderAdapter => ({
      id: "fixture",
      complete: async (request) => {
        started();
        return new Promise((_resolve, reject) => request.signal?.addEventListener("abort", () => {
          markAborted();
          reject(new DOMException("Aborted", "AbortError"));
        }, { once: true }));
      },
    });

    const firstPending = maybeGenerateSessionTitle({
      ...first,
      provider: provider(firstStarted, () => { firstAborted = true; }),
    });
    await firstReady;
    const secondPending = maybeGenerateSessionTitle({
      ...second,
      provider: provider(secondStarted, () => { secondAborted = true; }),
    });
    await secondReady;

    await resetSessionTitleGeneration(first.rootDir, first.session.sessionId);
    await firstPending;
    expect(firstAborted).toBe(true);
    expect(secondAborted).toBe(false);

    await resetSessionTitleGeneration(second.rootDir, second.session.sessionId);
    await secondPending;
    expect(secondAborted).toBe(true);
  });

  test("a stale completion cannot detach its replacement controller", async () => {
    const f = await fixture();
    let firstStarted!: () => void;
    let secondStarted!: () => void;
    let releaseFirst!: () => void;
    let secondAborted = false;
    const firstReady = new Promise<void>((resolve) => { firstStarted = resolve; });
    const secondReady = new Promise<void>((resolve) => { secondStarted = resolve; });
    const firstProvider: ProviderAdapter = {
      id: "fixture",
      complete: async (request) => {
        firstStarted();
        return new Promise((_resolve, reject) => request.signal?.addEventListener("abort", () => {
          releaseFirst = () => reject(new DOMException("Aborted", "AbortError"));
        }, { once: true }));
      },
    };
    const secondProvider: ProviderAdapter = {
      id: "fixture",
      complete: async (request) => {
        secondStarted();
        return new Promise((_resolve, reject) => request.signal?.addEventListener("abort", () => {
          secondAborted = true;
          reject(new DOMException("Aborted", "AbortError"));
        }, { once: true }));
      },
    };

    const firstPending = maybeGenerateSessionTitle({ ...f, provider: firstProvider });
    await firstReady;
    await resetSessionTitleGeneration(f.rootDir, f.session.sessionId);

    const secondPending = maybeGenerateSessionTitle({ ...f, provider: secondProvider });
    await secondReady;
    releaseFirst();
    await firstPending;

    await resetSessionTitleGeneration(f.rootDir, f.session.sessionId);
    await secondPending;
    expect(secondAborted).toBe(true);
  });
});
