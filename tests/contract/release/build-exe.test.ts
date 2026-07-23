import { describe, expect, test } from "bun:test";
import {
  STANDALONE_BUILD_DEFINES,
  TREE_SITTER_WORKER_ENTRYPOINT,
  TREE_SITTER_WORKER_RUNTIME_NAME,
  treeSitterWorkerPathForTarget,
} from "../../../scripts/build-exe";

describe("standalone build worker", () => {
  test("uses a flat emitted worker entrypoint for each Bun target", () => {
    expect(STANDALONE_BUILD_DEFINES.VESICLE_COMPILED_BINARY).toBe("true");
    expect(TREE_SITTER_WORKER_ENTRYPOINT).toBe("tree-sitter-worker.ts");
    expect(TREE_SITTER_WORKER_RUNTIME_NAME).toBe("tree-sitter-worker.js");
    expect(treeSitterWorkerPathForTarget("bun-windows-x64")).toBe("B:/~BUN/root/tree-sitter-worker.js");
    expect(treeSitterWorkerPathForTarget("bun-linux-x64")).toBe("/$bunfs/root/tree-sitter-worker.js");
  });

  test("pins web-tree-sitter into the standalone worker bundle", async () => {
    const source = await Bun.file(TREE_SITTER_WORKER_ENTRYPOINT).text();
    expect(source).toContain('import "web-tree-sitter";');
  });
});
