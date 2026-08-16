import { describe, expect, test } from "bun:test";

describe("fork native runtime pin", () => {
  test("theme module load pins the platform native library before the first FFI touch", async () => {
    // theme.ts imports native-runtime ahead of sharedSyntaxStyle (the first
    // FFI touch), and native-runtime pins the library at module load. If that
    // import ordering is ever dropped, getRenderLibPath falls back to the
    // fork's bundled chunk path and this assertion fails.
    await import("../../../src/tui/theme");
    const { getRenderLibPath } = await import("@3akhp/opentui-core");
    const path = getRenderLibPath()?.replace(/\\/g, "/");
    expect(path).toMatch(
      process.platform === "darwin"
        ? /\/node_modules\/@opentui\/core-darwin-(?:x64|arm64)\/libopentui\.dylib$/
        : /\/node_modules\/@3akhp\/opentui-core-[a-z0-9-]+\/(?:libopentui\.so|opentui\.dll)$/,
    );
  });
});
