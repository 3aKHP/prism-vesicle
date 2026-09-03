import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const PROJECT_ROOT = resolve(import.meta.dir, "../../..");

describe("release notes composition", () => {
  test("CHANGELOG companion pairing passes (bun run changelog:check)", () => {
    const result = spawnSync("bun", ["run", "changelog:check"], {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("in pair");
  });
});
