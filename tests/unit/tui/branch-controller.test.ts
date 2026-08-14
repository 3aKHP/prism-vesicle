import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createSessionStore } from "../../../src/core/session/store";
import { createBranchController, flattenBranchRows } from "../../../src/tui/branch/controller";

/**
 * The branch panel state machine against a real two-level candidate tree:
 * U1 forks into A and B; B continues to turn 2, which forks into C1 and C2
 * (C2 is the physical tail and therefore the active leaf).
 */

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "vesicle-branch-panel-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function buildTwoLevelTree() {
  const session = await createSessionStore(root, "s");
  await session.append({ role: "system", content: "prompt", metadata: { engine: "etl" } });
  const u1 = await session.append({ role: "user", content: "outline proposal" });
  const a = await session.append({ role: "assistant", content: "three-act structure" });
  const storeB = await createSessionStore(root, "s", { parentUuid: u1.uuid });
  const b = await storeB.append({ role: "assistant", content: "dual-line narrative" });
  const turn2 = await createSessionStore(root, "s");
  const u2 = await turn2.append({ role: "user", content: "expand the conflict" });
  const c1 = await turn2.append({ role: "assistant", content: "internal conflict" });
  const storeC2 = await createSessionStore(root, "s", { parentUuid: u2.uuid });
  const c2 = await storeC2.append({ role: "assistant", content: "external conflict" });
  return { u1, a, b, u2, c1, c2 };
}

function makeController(overrides: Partial<Parameters<typeof createBranchController>[0]> = {}) {
  const statuses: string[] = [];
  const switches: string[] = [];
  const regenerations: string[] = [];
  const controller = createBranchController({
    rootDir: root,
    sessionId: () => "s",
    busy: () => false,
    setStatus: (status) => statuses.push(status),
    applySwitch: async (toLeaf) => {
      switches.push(toLeaf);
      return true;
    },
    regenerateAt: async (forkUuid) => {
      regenerations.push(forkUuid);
    },
    ...overrides,
  });
  return { controller, statuses, switches, regenerations };
}

describe("branch panel controller", () => {
  test("opens with the full tree flattened and the active leaf selected", async () => {
    const tree = await buildTwoLevelTree();
    const { controller } = makeController();
    await controller.open();
    const state = controller.state();
    expect(state).not.toBeNull();

    const rows = flattenBranchRows(state!.forks, state!.expanded);
    // Default expansion follows the active path: U1 fork, both candidates,
    // B's nested U2 fork, both nested candidates.
    expect(rows.map((row) => row.kind)).toEqual(["fork", "candidate", "candidate", "fork", "candidate", "candidate"]);
    expect(rows.map((row) => row.depth)).toEqual([0, 1, 1, 2, 3, 3]);
    const candidateRows = rows.filter((row) => row.kind === "candidate");
    expect(candidateRows.map((row) => row.kind === "candidate" && row.candidate.excerpt)).toEqual([
      "three-act structure",
      "dual-line narrative",
      "internal conflict",
      "external conflict",
    ]);
    // Selection lands on the active leaf row (C2).
    expect(rows[state!.selected]).toMatchObject({ kind: "candidate", candidate: { activePath: true, endpointUuid: tree.c2.uuid } });
    void tree.a;
    void tree.b;
    void tree.c1;
    void tree.u1;
    void tree.u2;
  });

  test("entering a candidate confirms and applies its endpoint leaf", async () => {
    const tree = await buildTwoLevelTree();
    const { controller, switches } = makeController();
    await controller.open();

    // Move to candidate A (row index 1) and press Enter. Selection starts on
    // the deepest active candidate (row 5).
    expect(controller.state()?.selected).toBe(5);
    let state = controller.state()!;
    while (state.selected !== 1) {
      controller.handleKey({ name: "up" });
      state = controller.state()!;
    }
    controller.handleKey({ name: "enter" });
    // confirmSwitch computes the file preview asynchronously before arming
    // the confirm step.
    await new Promise((resolve) => setTimeout(resolve, 5));
    state = controller.state()!;
    expect(state.confirm?.kind).toBe("switch");
    expect(state.confirm?.candidate?.endpointUuid).toBe(tree.a.uuid);
    expect(state.confirm?.selected).toBe(0);

    controller.handleKey({ name: "enter" });
    // The busy flash settles and the panel closes after a successful switch.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(switches).toEqual([tree.a.uuid]);
    expect(controller.state()).toBeNull();
  });

  test("nevermind backs out of the confirm step without switching", async () => {
    await buildTwoLevelTree();
    const { controller, switches } = makeController();
    await controller.open();
    let state = controller.state()!;
    while (state.selected !== 1) {
      controller.handleKey({ name: "up" });
      state = controller.state()!;
    }
    controller.handleKey({ name: "enter" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.handleKey({ name: "down" });
    controller.handleKey({ name: "enter" });
    expect(switches).toEqual([]);
    expect(controller.state()?.confirm).toBeUndefined();
  });

  test("r on a fork row confirms regeneration of that turn", async () => {
    const tree = await buildTwoLevelTree();
    const { controller, regenerations } = makeController();
    await controller.open();
    // Walk up to the U1 fork row (index 0).
    let state = controller.state()!;
    while (state.selected !== 0) {
      controller.handleKey({ name: "up" });
      state = controller.state()!;
    }
    controller.handleKey({ name: "r" });
    expect(controller.state()?.confirm).toMatchObject({ kind: "regenerate", fork: { forkRecordUuid: tree.u1.uuid } });
    controller.handleKey({ name: "enter" });
    expect(regenerations).toEqual([tree.u1.uuid]);
    // Regeneration closes the panel before the turn runs.
    expect(controller.state()).toBeNull();
  });

  test("left collapses an expanded fork, right expands it again", async () => {
    await buildTwoLevelTree();
    const { controller } = makeController();
    await controller.open();
    // Move to the U2 fork row (depth 2, index 3).
    let state = controller.state()!;
    while (state.selected !== 3) {
      controller.handleKey({ name: "up" });
      state = controller.state()!;
    }
    controller.handleKey({ name: "left" });
    state = controller.state()!;
    expect(flattenBranchRows(state.forks, state.expanded)).toHaveLength(4);
    controller.handleKey({ name: "right" });
    state = controller.state()!;
    expect(flattenBranchRows(state.forks, state.expanded)).toHaveLength(6);
  });

  test("ctrl+b closes the panel", async () => {
    await buildTwoLevelTree();
    const { controller, statuses } = makeController();
    await controller.open();
    controller.handleKey({ name: "b", ctrl: true });
    expect(controller.state()).toBeNull();
    expect(statuses.at(-1)).toBe("ready");
  });

  test("opening while busy refuses with a status message", async () => {
    await buildTwoLevelTree();
    const { controller, statuses } = makeController({ busy: () => true });
    await controller.open();
    expect(controller.state()).toBeNull();
    expect(statuses.at(-1)).toBe("request in flight");
  });
});
