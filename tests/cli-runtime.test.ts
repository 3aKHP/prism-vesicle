import { describe, expect, test } from "bun:test";
import { isCompiledBinaryRuntime } from "../src/cli/runtime";

describe("compiled CLI runtime detection", () => {
  test("prefers the explicit standalone build marker", () => {
    expect(isCompiledBinaryRuntime(true, "/project/src/cli/main.ts")).toBe(true);
  });

  test("uses Bun's virtual path only as a source-run fallback", () => {
    expect(isCompiledBinaryRuntime(undefined, "/$bunfs/root/main.js")).toBe(true);
    expect(isCompiledBinaryRuntime(undefined, "/project/src/cli/main.ts")).toBe(false);
  });
});
