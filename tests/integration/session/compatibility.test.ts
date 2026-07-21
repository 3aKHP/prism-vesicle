import { mkdtemp, } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { createSessionStore, loadSessionMessages, loadSessionSnapshot } from "../../../src/core/session/store";

describe("session: compatibility", () => {
  test("restores the safe asset fingerprint from the initial system record", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-session-assets-"));
    const store = await createSessionStore(rootDir);
    const assets = {
      sha256: "a".repeat(64),
      files: [{ path: "assets/prompts/engines/etl.md", sha256: "b".repeat(64), source: "user" as const }],
    };
    await store.append({ role: "system", content: "prompt", metadata: { assets } });
    await store.append({ role: "user", content: "hello" });

    const snapshot = await loadSessionSnapshot(rootDir, store.sessionId);
    expect(snapshot.assets).toEqual(assets);
  });

  test("fails closed when initial Harness identity metadata is malformed", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-session-harness-invalid-"));
    const store = await createSessionStore(rootDir);
    await store.append({ role: "system", content: "prompt", metadata: { harness: { packId: "partial" } } });

    await expect(loadSessionSnapshot(rootDir, store.sessionId)).rejects.toThrow(
      "Session Harness identity is invalid",
    );
  });

  test("restores durable image attachment references without base64", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-session-images-"));
    const store = await createSessionStore(rootDir);
    const image = {
      id: "img_test",
      path: ".vesicle/attachments/test.png",
      mediaType: "image/png" as const,
      bytes: 3,
      sha256: "0".repeat(64),
      source: "clipboard" as const,
      filename: "capture.png",
    };
    await store.append({ role: "system", content: "prompt" });
    await store.append({
      role: "user",
      content: "inspect [Image #1]",
      metadata: { images: [{ ...image, data: "must-not-survive" }] },
    });

    const messages = await loadSessionMessages(rootDir, store.sessionId);
    expect(messages[0]).toMatchObject({ role: "user", images: [image] });
    expect(messages[0].images?.[0].data).toBeUndefined();
  });

});
