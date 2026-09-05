import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("reading lifecycle under the same Solid client conditions as the TUI", () => {
  const suite = fileURLToPath(new URL("../../support/reading-controller.acceptance.ts", import.meta.url));
  const result = Bun.spawnSync([process.execPath, "test", "--conditions=browser", suite], { stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
});

test("bottom panels and expanded reading render with the Solid client runtime", () => {
  const suite = fileURLToPath(new URL("../../support/reading-render.acceptance.tsx", import.meta.url));
  const result = Bun.spawnSync([process.execPath, "test", "--conditions=browser", "--preload", "@3akhp/opentui-solid/preload", suite], { stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
});
