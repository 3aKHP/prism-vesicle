import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { WorkspaceFilePreview } from "../../../../src/tui/workspace/tree-data";
import { createValidationOwner } from "../../../../src/tui/workspace/validation-owner";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "vesicle-ws-validation-owner-"));
  await mkdir(join(root, "workspace"), { recursive: true });
  await writeFile(join(root, "workspace/a.md"), "# A\n\nbody\n");
  await writeFile(join(root, "workspace/b.md"), "# B\n\nbody\n");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function makeOwner(overrides: Partial<{
  dirty: (path: string) => boolean;
  selectedFilePath: () => string | null;
  openFile: () => WorkspaceFilePreview | null;
  canEditOpenFile: () => boolean;
}> = {}) {
  const calls = {
    status: [] as Array<[string, string | undefined]>,
    jumps: [] as Array<[string, number]>,
  };
  const owner = createValidationOwner({
    rootDir: root,
    onStatus: (text, tone) => { calls.status.push([text, tone]); },
    isDirty: overrides.dirty ?? (() => false),
    selectedFilePath: overrides.selectedFilePath ?? (() => null),
    openFile: overrides.openFile ?? (() => null),
    canEditOpenFile: overrides.canEditOpenFile ?? (() => false),
    onJumpTo: (relPath, line) => { calls.jumps.push([relPath, line]); },
  });
  return { owner, calls };
}

const YAML_RESULT = "---\narchetype: x\n---\nbody\n";

describe("workspace validation owner: snapshot lifecycle", () => {
  test("setFor installs a result snapshot; clear resets to pending", () => {
    const { owner } = makeOwner();
    expect(owner.validationState()).toEqual({ state: "pending" });
    owner.setFor("workspace/a.md", YAML_RESULT);
    const snap = owner.validationSnapshot();
    expect(snap.state).toBe("result");
    if (snap.state === "result") {
      expect(snap.path).toBe("workspace/a.md");
      expect(owner.canJumpToSelectedFinding()).toBe(false);
    }
    owner.clear();
    expect(owner.validationState()).toEqual({ state: "pending" });
  });

  test("dirty buffer projects the snapshot to stale without losing the result", () => {
    const dirtyPaths = new Set<string>();
    const { owner } = makeOwner({ dirty: (p) => dirtyPaths.has(p) });
    owner.setFor("workspace/a.md", YAML_RESULT);
    dirtyPaths.add("workspace/a.md");
    expect(owner.validationState()).toEqual({ state: "stale", path: "workspace/a.md" });
    dirtyPaths.delete("workspace/a.md");
    expect(owner.validationState().state).toBe("result");
  });

  test("rekey moves the snapshot path and keeps the verdict", () => {
    const { owner } = makeOwner();
    owner.setFor("workspace/a.md", YAML_RESULT);
    owner.rekey("workspace/a.md", "workspace/renamed.md");
    expect(owner.validationSnapshot()).toMatchObject({ state: "result", path: "workspace/renamed.md" });
  });
});

describe("workspace validation owner: typed mutations", () => {
  test("applyMutation(moved) rekeys the snapshot path", () => {
    const { owner } = makeOwner();
    owner.setFor("workspace/a.md", YAML_RESULT);
    owner.applyMutation({ kind: "moved", source: "workspace/a.md", target: "workspace/renamed.md" });
    expect(owner.validationSnapshot()).toMatchObject({ state: "result", path: "workspace/renamed.md" });
  });

  test("applyMutation(deleted) clears a snapshot that owns the deleted path", () => {
    const { owner } = makeOwner();
    owner.setFor("workspace/a.md", YAML_RESULT);
    owner.applyMutation({ kind: "deleted", path: "workspace/a.md" });
    expect(owner.validationState()).toEqual({ state: "pending" });
  });

  test("applyMutation(deleted) leaves a snapshot for another path untouched", () => {
    const { owner } = makeOwner();
    owner.setFor("workspace/a.md", YAML_RESULT);
    owner.applyMutation({ kind: "deleted", path: "workspace/b.md" });
    expect(owner.validationSnapshot()).toMatchObject({ state: "result", path: "workspace/a.md" });
  });
});

describe("workspace validation owner: triggering and navigation", () => {
  test("treeValidate validates the selected file and opens findings", async () => {
    const { owner } = makeOwner({
      selectedFilePath: () => "workspace/a.md",
      openFile: () => null,
      canEditOpenFile: () => false,
    });
    // The fixture must be a validator-matching artifact (Module A/B shape).
    await writeFile(join(root, "workspace/a.md"), YAML_RESULT);
    await owner.treeValidate();
    expect(owner.findingsOpen()).toBe(true);
    expect(owner.validationSnapshot().state).toBe("result");
  });

  test("treeValidate refuses a dirty buffer with a status hint", async () => {
    const { owner, calls } = makeOwner({
      selectedFilePath: () => "workspace/a.md",
      dirty: (p) => p === "workspace/a.md",
    });
    await owner.treeValidate();
    expect(owner.findingsOpen()).toBe(false);
    expect(calls.status.at(-1)?.[0]).toContain("save");
  });

  test("findings navigation moves the index and jumps through the port", () => {
    const { owner, calls } = makeOwner({
      openFile: () => ({ kind: "text", relPath: "workspace/a.md", size: 1, readonly: false, symlink: false, oversized: false }) as WorkspaceFilePreview,
      canEditOpenFile: () => true,
    });
    owner.setFor("workspace/a.md", YAML_RESULT);
    expect(owner.canJumpToSelectedFinding()).toBe(true);
    owner.handleFindingsKey({ name: "enter" } as never);
    expect(owner.findingsOpen()).toBe(false);
    expect(calls.jumps.length).toBe(1);
  });

  test("findings navigation refuses a cross-file jump", () => {
    const { owner, calls } = makeOwner({
      openFile: () => ({ kind: "text", relPath: "workspace/b.md", size: 1, readonly: false, symlink: false, oversized: false }) as WorkspaceFilePreview,
      canEditOpenFile: () => true,
    });
    // The snapshot belongs to a.md while b.md is open: Enter must not jump.
    owner.setFor("workspace/a.md", YAML_RESULT);
    expect(owner.canJumpToSelectedFinding()).toBe(false);
    owner.handleFindingsKey({ name: "enter" } as never);
    expect(calls.jumps.length).toBe(0);
  });
});
