import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { FileCheckpointManager } from "../../../src/core/checkpoints/file-history";
import {
  listRewindPoints,
  rewindCodeAndConversation,
  rewindConversation,
} from "../../../src/core/rewind/service";
import { createSessionStore } from "../../../src/core/session/store";
import { executeFileTool } from "../../../src/core/tools";

describe("rewind service", () => {
  test("lists only authored prompts and rewinds to immediately before the selected prompt", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-rewind-"));
    const store = await createSessionStore(rootDir, "rewind-conversation");
    await store.append({ role: "system", content: "prompt", metadata: { engine: "etl" } });
    await store.append({ role: "user", content: "first" });
    await store.append({ role: "assistant", content: "answer one" });
    await store.append({ role: "user", content: "[gate] confirm", metadata: { kind: "gate-resolution" } });
    await store.append({ role: "assistant", content: "after gate" });
    await store.append({ role: "user", content: "[engine_handoff]\nSource: manual\n[/engine_handoff]", metadata: { kind: "engine-handoff" } });
    await store.append({ role: "user", content: "second" });
    await store.append({ role: "assistant", content: "answer two" });

    const points = await listRewindPoints(rootDir, store.sessionId);
    expect(points.map((point) => point.content)).toEqual(["first", "second"]);

    const rewound = await rewindConversation(rootDir, store.sessionId, points[1]!);
    expect(rewound.prompt).toBe("second");
    expect(rewound.snapshot.messages.map((message) => message.content)).toEqual([
      "first",
      "answer one",
      "[gate] confirm",
      "after gate",
      "[engine_handoff]\nSource: manual\n[/engine_handoff]",
    ]);
    expect(rewound.snapshot.pendingGate).toBeUndefined();

    const reopenedBeforeResubmit = await listRewindPoints(rootDir, store.sessionId, { headUuid: rewound.parentUuid });
    expect(reopenedBeforeResubmit.map((point) => point.content)).toEqual(["first"]);
  });

  test("restores code and returns a conversation branch in one operation", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-rewind-both-"));
    await mkdir(join(rootDir, "workspace"), { recursive: true });
    await writeFile(join(rootDir, "workspace", "card.md"), "before", "utf8");
    const store = await createSessionStore(rootDir, "rewind-both");
    await store.append({ role: "system", content: "prompt" });
    const user = await store.append({ role: "user", content: "change card" });
    const checkpoint = new FileCheckpointManager(rootDir, store, user.uuid);
    await checkpoint.createSnapshot();
    await executeFileTool(rootDir, {
      id: "write",
      name: "write_file",
      arguments: JSON.stringify({ path: "workspace/card.md", content: "after" }),
    }, { beforeMutation: (paths) => checkpoint.trackBeforeMutation(paths) });
    await store.append({ role: "assistant", content: "changed" });

    const point = (await listRewindPoints(rootDir, store.sessionId))[0]!;
    const rewound = await rewindCodeAndConversation(rootDir, store.sessionId, point);
    expect(rewound.restoredFiles).toEqual(["workspace/card.md"]);
    expect(await readFile(join(rootDir, "workspace", "card.md"), "utf8")).toBe("before");
    expect(rewound.snapshot.messages).toEqual([]);
    expect(rewound.prompt).toBe("change card");
  });

  test("marks rewind points whose file completeness was tainted by shell_exec", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-rewind-tainted-"));
    const store = await createSessionStore(rootDir, "rewind-tainted");
    await store.append({ role: "system", content: "prompt" });
    const user = await store.append({ role: "user", content: "run shell" });
    const checkpoint = new FileCheckpointManager(rootDir, store, user.uuid);
    await checkpoint.createSnapshot();
    await checkpoint.markTaintedByHostProcess();
    await store.append({ role: "assistant", content: "done" });

    const point = (await listRewindPoints(rootDir, store.sessionId))[0]!;
    expect(point.checkpointTainted).toBe(true);
  });
});
