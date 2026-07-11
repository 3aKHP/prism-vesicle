import { describe, expect, test } from "bun:test";
import {
  TREE_SITTER_WORKER_ENTRYPOINT,
  TREE_SITTER_WORKER_RUNTIME_NAME,
  treeSitterWorkerPathForTarget,
} from "../scripts/build-exe";

describe("standalone build worker", () => {
  test("uses a flat emitted worker entrypoint for each Bun target", () => {
    expect(TREE_SITTER_WORKER_ENTRYPOINT).toBe("tree-sitter-worker.ts");
    expect(TREE_SITTER_WORKER_RUNTIME_NAME).toBe("tree-sitter-worker.js");
    expect(treeSitterWorkerPathForTarget("bun-windows-x64")).toBe("B:/~BUN/root/tree-sitter-worker.js");
    expect(treeSitterWorkerPathForTarget("bun-linux-x64")).toBe("/$bunfs/root/tree-sitter-worker.js");
  });
});
