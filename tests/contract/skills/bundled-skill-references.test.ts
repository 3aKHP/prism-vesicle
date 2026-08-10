import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const PROJECT_ROOT = resolve(import.meta.dir, "../../..");

describe("bundled skill references synchronization", () => {
  test("--check passes when references are in sync with public source", () => {
    const result = spawnSync("bun", ["run", "skills:docs:check"], {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("in sync");
  });

  test("sync is deterministic (second run produces no change)", () => {
    const first = spawnSync("bun", ["run", "skills:docs:sync"], {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(first.status).toBe(0);
    const check = spawnSync("bun", ["run", "skills:docs:check"], {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(check.status).toBe(0);
  });
});
