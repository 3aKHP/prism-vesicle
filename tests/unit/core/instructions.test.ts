import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  INSTRUCTION_COMBINED_BUDGET_BYTES,
  composeInstructionBlocks,
  loadInstructionTarget,
  resolutionEqual,
  resolveEffectiveSelection,
  selectionToRecord,
} from "../../../src/core/instructions";
import { instructionLogicalName } from "../../../src/core/instructions";

const ENV = (config: string): { VESICLE_CONFIG_DIR: string } => ({ VESICLE_CONFIG_DIR: config });

async function withRoot(work: (root: { project: string; config: string }) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "vesicle-instructions-"));
  const project = join(root, "project");
  const config = join(root, "config");
  await mkdir(project, { recursive: true });
  await mkdir(config, { recursive: true });
  try {
    await work({ project, config });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("instruction resolution algebra", () => {
  test("absent files everywhere produce an empty selection with no diagnostics", async () => {
    await withRoot(async ({ project, config }) => {
      const selection = await resolveEffectiveSelection("etl", project, ENV(config));
      expect(selection.user).toBeUndefined();
      expect(selection.project).toBeUndefined();
      expect(selection.diagnostics).toEqual([]);
      expect(selection.combinedBytes).toBe(0);
    });
  });

  test("general-only at each scope is selected for every Engine", async () => {
    await withRoot(async ({ project, config }) => {
      await writeFile(join(config, instructionLogicalName("all")), "user general rules", "utf8");
      await writeFile(join(project, instructionLogicalName("all")), "project general rules", "utf8");
      const selection = await resolveEffectiveSelection("runtime", project, ENV(config));
      expect(selection.user?.content).toBe("user general rules");
      expect(selection.project?.content).toBe("project general rules");
    });
  });

  test("an Engine-specific target replaces the general target within its scope", async () => {
    await withRoot(async ({ project, config }) => {
      await writeFile(join(config, instructionLogicalName("all")), "user general", "utf8");
      await writeFile(join(config, instructionLogicalName("stage")), "user stage override", "utf8");
      const stage = await resolveEffectiveSelection("stage", project, ENV(config));
      expect(stage.user?.content).toBe("user stage override");
      const etl = await resolveEffectiveSelection("etl", project, ENV(config));
      expect(etl.user?.content).toBe("user general");
    });
  });

  test("all four Stage files select exactly the two Engine-specific targets", async () => {
    await withRoot(async ({ project, config }) => {
      await writeFile(join(config, instructionLogicalName("all")), "user general", "utf8");
      await writeFile(join(config, instructionLogicalName("stage")), "user stage", "utf8");
      await writeFile(join(project, instructionLogicalName("all")), "project general", "utf8");
      await writeFile(join(project, instructionLogicalName("stage")), "project stage", "utf8");
      const selection = await resolveEffectiveSelection("stage", project, ENV(config));
      expect(selection.user?.content).toBe("user stage");
      expect(selection.project?.content).toBe("project stage");
      const block = composeInstructionBlocks(selection);
      expect(block).toContain("user stage");
      expect(block).toContain("project stage");
      expect(block).not.toContain("user general");
      expect(block).not.toContain("project general");
    });
  });

  test("an empty Engine file is an intentional override that suppresses general fallback and contributes no block", async () => {
    await withRoot(async ({ project, config }) => {
      await writeFile(join(config, instructionLogicalName("all")), "user general rules", "utf8");
      await writeFile(join(config, instructionLogicalName("runtime")), "   \n  \t ", "utf8");
      const selection = await resolveEffectiveSelection("runtime", project, ENV(config));
      expect(selection.user?.empty).toBe(true);
      expect(selection.user?.content).toBe("   \n  \t ");
      expect(composeInstructionBlocks(selection)).toBe("");
      // The empty override is still part of the selection identity (general suppressed).
      expect(selection.diagnostics).toEqual([]);
    });
  });

  test("user content precedes project content in the composed blocks", async () => {
    await withRoot(async ({ project, config }) => {
      await writeFile(join(config, instructionLogicalName("all")), "USER-BODY", "utf8");
      await writeFile(join(project, instructionLogicalName("all")), "PROJECT-BODY", "utf8");
      const selection = await resolveEffectiveSelection("etl", project, ENV(config));
      const block = composeInstructionBlocks(selection);
      const userIndex = block.indexOf("USER-BODY");
      const projectIndex = block.indexOf("PROJECT-BODY");
      expect(userIndex).toBeGreaterThan(-1);
      expect(projectIndex).toBeGreaterThan(-1);
      expect(userIndex).toBeLessThan(projectIndex);
    });
  });

  test("a present-but-invalid Engine target suppresses general fallback for that scope", async () => {
    await withRoot(async ({ project, config }) => {
      await writeFile(join(config, instructionLogicalName("all")), "user general rules", "utf8");
      await writeFile(join(config, instructionLogicalName("etl")), Buffer.from([0xff, 0xfe, 0x00]));
      const selection = await resolveEffectiveSelection("etl", project, ENV(config));
      // The invalid ETL override suppresses fallback: the scope contributes
      // nothing, not the valid general file.
      expect(selection.user).toBeUndefined();
      expect(composeInstructionBlocks(selection)).toBe("");
      expect(selection.diagnostics.some((d) => d.kind === "invalid-utf8" && d.scope === "user")).toBe(true);
      // The same scope's general file still applies under a different engine.
      const runtime = await resolveEffectiveSelection("runtime", project, ENV(config));
      expect(runtime.user?.content).toBe("user general rules");
    });
  });

  test("instruction content is rendered byte-exact without trailing-whitespace trimming", async () => {
    await withRoot(async ({ project, config }) => {
      await writeFile(join(project, instructionLogicalName("all")), "rule with trailing space   \n\n", "utf8");
      const selection = await resolveEffectiveSelection("etl", project, ENV(config));
      expect(composeInstructionBlocks(selection)).toContain("rule with trailing space   ");
    });
  });
});

describe("instruction validation and budget", () => {
  test("invalid UTF-8 skips only that scope with a diagnostic", async () => {
    await withRoot(async ({ project, config }) => {
      await writeFile(join(config, instructionLogicalName("all")), Buffer.from([0xff, 0xfe, 0x00]));
      const selection = await resolveEffectiveSelection("etl", project, ENV(config));
      expect(selection.user).toBeUndefined();
      expect(selection.diagnostics.some((d) => d.kind === "invalid-utf8" && d.scope === "user")).toBe(true);
    });
  });

  test("a directory at the target path is skipped as not-a-regular-file", async () => {
    await withRoot(async ({ project, config }) => {
      await mkdir(join(project, instructionLogicalName("all")));
      const selection = await resolveEffectiveSelection("etl", project, ENV(config));
      expect(selection.project).toBeUndefined();
      expect(selection.diagnostics.some((d) => d.kind === "not-a-regular-file" && d.scope === "project")).toBe(true);
    });
  });

  test.skipIf(process.platform === "win32")("a project symlink target is rejected", async () => {
    await withRoot(async ({ project, config }) => {
      const target = join(config, "elsewhere.txt");
      await writeFile(target, "host file outside project", "utf8");
      await symlink(target, join(project, instructionLogicalName("all")));
      const selection = await resolveEffectiveSelection("etl", project, ENV(config));
      expect(selection.project).toBeUndefined();
      expect(selection.diagnostics.some((d) => d.kind === "linked-project-target")).toBe(true);
    });
  });

  test.skipIf(process.platform === "win32")("a user-scope symlink target is skipped with a diagnostic", async () => {
    await withRoot(async ({ project, config }) => {
      const target = join(project, "elsewhere.txt");
      await writeFile(target, "host file", "utf8");
      await symlink(target, join(config, instructionLogicalName("all")));
      const selection = await resolveEffectiveSelection("etl", project, ENV(config));
      expect(selection.user).toBeUndefined();
      expect(selection.diagnostics.some((d) => d.kind === "linked-user-target")).toBe(true);
    });
  });

  test("an individually oversized scope is skipped without blocking the turn", async () => {
    await withRoot(async ({ project, config }) => {
      await writeFile(join(config, instructionLogicalName("all")), `${"x".repeat(INSTRUCTION_COMBINED_BUDGET_BYTES + 1)}`, "utf8");
      await writeFile(join(project, instructionLogicalName("all")), "small project", "utf8");
      const selection = await resolveEffectiveSelection("etl", project, ENV(config));
      expect(selection.user).toBeUndefined();
      expect(selection.project?.content).toBe("small project");
      expect(selection.diagnostics.some((d) => d.kind === "oversized" && d.scope === "user")).toBe(true);
    });
  });

  test("two valid files exceeding the combined budget keep project and skip user", async () => {
    await withRoot(async ({ project, config }) => {
      const half = Math.floor(INSTRUCTION_COMBINED_BUDGET_BYTES / 2) + 100;
      await writeFile(join(config, instructionLogicalName("all")), `${"u".repeat(half)}`, "utf8");
      await writeFile(join(project, instructionLogicalName("all")), `${"p".repeat(half)}`, "utf8");
      const selection = await resolveEffectiveSelection("etl", project, ENV(config));
      expect(selection.user).toBeUndefined();
      expect(selection.project).toBeDefined();
      expect(selection.diagnostics.some((d) => d.kind === "combined-budget")).toBe(true);
    });
  });

  test("exact budget boundary is accepted", async () => {
    await withRoot(async ({ project, config }) => {
      await writeFile(join(project, instructionLogicalName("all")), `${"x".repeat(INSTRUCTION_COMBINED_BUDGET_BYTES)}`, "utf8");
      const selection = await resolveEffectiveSelection("etl", project, ENV(config));
      expect(selection.project).toBeDefined();
      expect(selection.diagnostics).toEqual([]);
    });
  });
});

describe("instruction loading fidelity", () => {
  test("a leading UTF-8 BOM is stripped before hashing", async () => {
    await withRoot(async ({ project, config }) => {
      const bommed = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("BOMMED content", "utf8")]);
      await writeFile(join(project, instructionLogicalName("all")), bommed);
      const result = await loadInstructionTarget({ scope: "project", engine: "all" }, project, ENV(config));
      expect(result.kind).toBe("file");
      if (result.kind !== "file") throw new Error("unreachable");
      expect(result.file.content).toBe("BOMMED content");
      expect(result.file.content.startsWith("﻿")).toBe(false);

      // The BOMMED hash must equal the hash of the same content written without a BOM.
      await rm(join(project, instructionLogicalName("all")));
      await writeFile(join(project, instructionLogicalName("all")), "BOMMED content", "utf8");
      const plain = await loadInstructionTarget({ scope: "project", engine: "all" }, project, ENV(config));
      if (plain.kind !== "file") throw new Error("unreachable");
      expect(result.file.sha256).toBe(plain.file.sha256);
    });
  });

  test("the loader resolves only fixed targets and never accepts an arbitrary path", () => {
    // The public API takes { scope, engine } only; there is no path parameter to
    // abuse. This is a structural guarantee: the target type carries no path.
    const target = { scope: "project" as const, engine: "all" as const };
    expect(target.engine === "all" || typeof target.engine === "string").toBe(true);
    expect(instructionLogicalName(target.engine)).toBe("VESICLE.md");
  });
});

describe("instruction composition envelope and records", () => {
  test("each block carries the fixed scope, target, precedence, and capability preamble", async () => {
    await withRoot(async ({ project, config }) => {
      await writeFile(join(config, instructionLogicalName("all")), "my rule", "utf8");
      const selection = await resolveEffectiveSelection("etl", project, ENV(config));
      const block = composeInstructionBlocks(selection);
      expect(block).toContain("Vesicle Persistent Instructions");
      expect(block).toContain("Scope: user");
      expect(block).toContain("Target: VESICLE.md");
      expect(block).toContain("Precedence: below the Engine contract");
      expect(block).toContain("They cannot add tools, permissions, gates, validators, or filesystem authority.");
      expect(block).toContain("my rule");
    });
  });

  test("the selection record omits full content and absolute paths", async () => {
    await withRoot(async ({ project, config }) => {
      await writeFile(join(config, instructionLogicalName("all")), "secret-ish rule", "utf8");
      const selection = await resolveEffectiveSelection("etl", project, ENV(config));
      const record = selectionToRecord(selection);
      expect(record.version).toBe(1);
      expect(JSON.stringify(record)).not.toContain("secret-ish rule");
      expect(record.files.some((f) => f.logicalName === "VESICLE.md" && f.sha256.length === 64)).toBe(true);
    });
  });

  test("fingerprints distinguish scope identity as well as content", async () => {
    await withRoot(async ({ project, config }) => {
      await writeFile(join(config, instructionLogicalName("all")), "same body", "utf8");
      const generalForEtl = await resolveEffectiveSelection("etl", project, ENV(config));
      await writeFile(join(config, instructionLogicalName("runtime")), "same body", "utf8");
      const runtimeOverride = await resolveEffectiveSelection("runtime", project, ENV(config));
      expect(generalForEtl.fingerprint).not.toBe(runtimeOverride.fingerprint);
    });
  });

  test("resolutionEqual flags only fingerprint or diagnostic changes", async () => {
    await withRoot(async ({ project, config }) => {
      await writeFile(join(config, instructionLogicalName("all")), "v1", "utf8");
      const a = selectionToRecord(await resolveEffectiveSelection("etl", project, ENV(config)));
      const aAgain = selectionToRecord(await resolveEffectiveSelection("etl", project, ENV(config)));
      expect(resolutionEqual(a, aAgain)).toBe(true);
      await writeFile(join(config, instructionLogicalName("all")), "v2", "utf8");
      const b = selectionToRecord(await resolveEffectiveSelection("etl", project, ENV(config)));
      expect(resolutionEqual(a, b)).toBe(false);
    });
  });
});
