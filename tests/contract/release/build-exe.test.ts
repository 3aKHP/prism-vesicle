import { describe, expect, test } from "bun:test";
import {
  assertNativeWindowsBuildRoot,
  STANDALONE_BUILD_DEFINES,
  TREE_SITTER_WORKER_ENTRYPOINT,
  TREE_SITTER_WORKER_RUNTIME_NAME,
  WINDOWS_CROSS_ARTIFACT,
  WINDOWS_RELEASE_ARTIFACT,
  treeSitterWorkerPathForTarget,
  windowsArtifactForHost,
} from "../../../scripts/build/build-exe";
import { numericFileVersion } from "../../../scripts/build/windows-version";

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

  test("rejects native Windows builds from UNC roots before compiling a misplaced worker", () => {
    expect(() => assertNativeWindowsBuildRoot("win32", "\\\\wsl.localhost\\Ubuntu\\repo")).toThrow("drive-letter workspace");
    expect(() => assertNativeWindowsBuildRoot("win32", "C:\\repo")).not.toThrow();
    expect(() => assertNativeWindowsBuildRoot("linux", "/home/user/repo")).not.toThrow();
  });

  test("keeps native release and non-native cross-build artifacts distinct", () => {
    expect(WINDOWS_RELEASE_ARTIFACT).toBe("prism-vesicle.exe");
    expect(WINDOWS_CROSS_ARTIFACT).toBe("prism-vesicle-cross-windows-x64.exe");
    expect(windowsArtifactForHost("win32")).toBe(WINDOWS_RELEASE_ARTIFACT);
    expect(windowsArtifactForHost("linux")).toBe(WINDOWS_CROSS_ARTIFACT);
    expect(numericFileVersion("1.0.0-rc.1")).toBe("1.0.0.0");
  });
});
