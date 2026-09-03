import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSkillActivationOwner, type SkillActivationOwnerPorts } from "../../../src/tui/skills/session-activation";
import { catalogNames } from "../../../src/core/skills";

/**
 * The #309 regression surface: the `/skill` picker may only list the
 * session-aware catalog the host resolves (what activation would resolve),
 * never a fresh disk scan, and resolving that list must never create a
 * session or widen one into existence.
 */

describe("skill picker controller", () => {
  test("lists and activates exactly the session-aware resolver's catalog", async () => {
    // Memo-driven picker state needs solid's reactive build, so the assertions
    // live in a probe run under the fork's preload (see the probe header).
    const probe = Bun.spawn([
      process.execPath,
      "--preload",
      "@3akhp/opentui-solid/preload",
      "tests/support/skill-picker-catalog-probe.ts",
    ], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const timeout = setTimeout(() => probe.kill(), 10_000);
    const [exitCode, stdout, stderr] = await Promise.all([
      probe.exited.finally(() => clearTimeout(timeout)),
      new Response(probe.stdout).text(),
      new Response(probe.stderr).text(),
    ]);
    if (exitCode !== 0) throw new Error(`Skill picker catalog probe failed:\n${stdout}\n${stderr}`);
    expect(stdout).toContain("skill picker catalog probe passed");
  }, 15_000);
});

describe("skill activation owner resolveCatalog", () => {
  let scratch: string;
  let previousConfigDir: string | undefined;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "vesicle-picker-catalog-"));
    previousConfigDir = process.env.VESICLE_CONFIG_DIR;
    process.env.VESICLE_CONFIG_DIR = join(scratch, "config");
    const root = join(scratch, "config", "skills", "alpha");
    await mkdir(root, { recursive: true });
    await Bun.write(
      join(root, "SKILL.md"),
      "---\nname: alpha\ndescription: alpha description\n---\n\n# alpha\n\nProcedure body for alpha.\n",
    );
  });

  afterEach(async () => {
    if (previousConfigDir === undefined) delete process.env.VESICLE_CONFIG_DIR;
    else process.env.VESICLE_CONFIG_DIR = previousConfigDir;
    await rm(scratch, { recursive: true, force: true });
  });

  function ownerPorts(overrides: Partial<SkillActivationOwnerPorts> = {}): SkillActivationOwnerPorts {
    return {
      rootDir: scratch,
      // Opening the picker must not create a session; ensure failing loudly
      // here turns a silent identity creation into a test failure.
      sessionIdentity: {
        ensure: async () => {
          throw new Error("picker catalog resolution must not ensure a session identity");
        },
      },
      currentSessionId: () => undefined,
      activeEngine: () => "etl",
      activeModelLimits: () => undefined,
      branchParent: () => null,
      setBranchParent: () => {},
      onNotice: () => {},
      submitTurn: async () => {},
      ...overrides,
    };
  }

  test("resolves the fresh catalog without ensuring a session when none exists", async () => {
    const owner = createSkillActivationOwner(ownerPorts());
    expect(catalogNames(await owner.resolveCatalog())).toContain("alpha");
  });

  test("Stage resolves to an empty picker list", async () => {
    const owner = createSkillActivationOwner(ownerPorts({ activeEngine: () => "stage" }));
    expect(catalogNames(await owner.resolveCatalog())).toEqual([]);
  });
});
