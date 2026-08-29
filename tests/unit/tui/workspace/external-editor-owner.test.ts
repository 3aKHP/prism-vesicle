import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExternalEditOutcome } from "../../../../src/tui/workspace/types";
import { createExternalEditorOwner } from "../../../../src/tui/workspace/external-editor-owner";
import type { EditorRuntime } from "../../../../src/tui/workspace/external-editor-runtime";

let root: string;
let savedEnv: NodeJS.ProcessEnv;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "vesicle-ws-ext-owner-"));
  await mkdir(join(root, "sub"), { recursive: true });
  await writeFile(join(root, "notes.txt"), "line one\nline two\n");
  // Pin env so editor resolution + settings.yaml are deterministic and don't
  // touch the real user config.
  savedEnv = { ...process.env };
  process.env.VESICLE_EDITOR = "mockedit";
  process.env.VESICLE_CONFIG_DIR = root;
});

afterEach(async () => {
  process.env = savedEnv;
  await rm(root, { recursive: true, force: true });
});

function mockRuntime() {
  const calls = { suspend: 0, resume: 0, spawn: [] as string[], exitCode: 0, spawnError: false };
  const runtime = {
    suspend: () => { calls.suspend += 1; },
    resume: () => { calls.resume += 1; },
    spawn: async (command: string, args: string[]) => {
      if (calls.spawnError) throw new Error("ENOENT");
      calls.spawn.push([command, ...args].join(" "));
      return calls.exitCode;
    },
    calls,
  };
  return runtime as typeof runtime & EditorRuntime;
}

function makeOwner(overrides: {
  target?: string | null;
  dirty?: boolean;
  reconcileOutcome?: ExternalEditOutcome;
} = {}) {
  const calls = {
    status: [] as Array<[string, string | undefined]>,
    reconciles: [] as string[],
    invalidated: [] as string[],
    refreshes: 0,
    viewerReloads: [] as string[],
    viewerCloses: [] as string[],
    returned: 0,
  };
  const runtime = mockRuntime();
  const owner = createExternalEditorOwner({
    rootDir: root,
    onStatus: (text, tone) => { calls.status.push([text, tone]); },
    onReturned: () => { calls.returned += 1; },
    resolveHandoffTarget: () => ("target" in overrides ? overrides.target : "notes.txt") ?? null,
    buffer: {
      isDirty: () => overrides.dirty === true,
      reconcile: async (path) => {
        calls.reconciles.push(path);
        return overrides.reconcileOutcome ?? "unchanged";
      },
    },
    tree: {
      invalidateCache: (path) => { calls.invalidated.push(path); },
      refreshRowsAndIndex: async () => { calls.refreshes += 1; },
    },
    viewer: {
      reloadIfShowing: async (path) => { calls.viewerReloads.push(path); },
      closeIfShowing: (path) => { calls.viewerCloses.push(path); },
    },
  });
  const unregister = owner.registerExternalEditor(runtime);
  return { owner, calls, unregister, runtime };
}

describe("workspace external-editor owner: handoff", () => {
  test("handoff spawns the resolved editor over the abs path and reconciles", async () => {
    const { owner, calls, runtime } = makeOwner();
    await owner.handoffToExternal();
    expect(runtime.calls.suspend).toBe(1);
    expect(runtime.calls.resume).toBe(1);
    expect(runtime.calls.spawn).toEqual([`mockedit ${join(root, "notes.txt")}`]);
    expect(calls.status.some(([t]) => t.startsWith("opening notes.txt in mockedit"))).toBe(true);
    expect(calls.reconciles).toEqual(["notes.txt"]);
    expect(calls.returned).toBe(1);
  });

  test("a null handoff target aborts before any spawn", async () => {
    const { owner, calls, runtime } = makeOwner({ target: null });
    await owner.handoffToExternal();
    expect(runtime.calls.spawn.length).toBe(0);
    expect(calls.invalidated.length).toBe(0);
  });

  test("a directory target is refused", async () => {
    const { owner, calls, runtime } = makeOwner({ target: "sub" });
    await owner.handoffToExternal();
    expect(runtime.calls.spawn.length).toBe(0);
    expect(calls.status.some(([t]) => t.includes("is a directory"))).toBe(true);
  });

  test("the dirty gate refuses an unsaved buffer", async () => {
    const { owner, calls, runtime } = makeOwner({ dirty: true });
    await owner.handoffToExternal();
    expect(runtime.calls.spawn.length).toBe(0);
    expect(calls.status.some(([t]) => t.includes("has unsaved edits"))).toBe(true);
  });

  test("malformed settings.yaml refuses the handoff", async () => {
    await writeFile(join(root, "settings.yaml"), "malformed line without colon\n");
    const { owner, calls, runtime } = makeOwner();
    await owner.handoffToExternal();
    expect(runtime.calls.spawn.length).toBe(0);
    expect(calls.status.some(([t]) => t.includes("settings.yaml is malformed"))).toBe(true);
  });

  test("a non-zero exit code warns but still reconciles", async () => {
    const { owner, calls, runtime } = makeOwner();
    runtime.calls.exitCode = 7;
    await owner.handoffToExternal();
    expect(runtime.calls.spawn.length).toBe(1);
    expect(calls.status.some(([t]) => t.includes("editor exited with code 7"))).toBe(true);
    expect(calls.reconciles).toEqual(["notes.txt"]);
  });

  test("a spawn failure reports it and skips reconciliation", async () => {
    const { owner, calls, runtime } = makeOwner();
    runtime.calls.spawnError = true;
    await owner.handoffToExternal();
    expect(calls.status.some(([t]) => t.includes("failed to start"))).toBe(true);
    expect(calls.invalidated.length).toBe(0);
  });
});

describe("workspace external-editor owner: return reconciliation", () => {
  test("not-resident refreshes the tree and the viewer", async () => {
    const { owner, calls } = makeOwner({ reconcileOutcome: "not-resident" });
    await owner.refreshAfterExternalEdit("notes.txt");
    expect(calls.invalidated).toEqual(["notes.txt"]);
    expect(calls.refreshes).toBe(1);
    expect(calls.viewerReloads).toEqual(["notes.txt"]);
    expect(calls.viewerCloses.length).toBe(0);
    expect(calls.returned).toBe(0);
  });

  test("removed closes the viewer; modified/unchanged touch neither", async () => {
    const { owner, calls } = makeOwner({ reconcileOutcome: "removed" });
    await owner.refreshAfterExternalEdit("notes.txt");
    expect(calls.viewerCloses).toEqual(["notes.txt"]);
    expect(calls.viewerReloads.length).toBe(0);

    const modified = makeOwner({ reconcileOutcome: "modified" });
    await modified.owner.refreshAfterExternalEdit("notes.txt");
    expect(modified.calls.viewerReloads.length).toBe(0);
    expect(modified.calls.viewerCloses.length).toBe(0);
    expect(modified.calls.refreshes).toBe(0);
  });

  test("unregister clears the injected runtime so handoff reports unavailable", async () => {
    const { owner, calls, runtime, unregister } = makeOwner();
    unregister();
    await owner.handoffToExternal();
    expect(runtime.calls.spawn.length).toBe(0);
    expect(calls.status.some(([t]) => t.includes("unavailable in this build"))).toBe(true);
  });
});
