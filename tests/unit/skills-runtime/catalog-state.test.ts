import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  clearSessionActivations,
  getActivatedSkill,
  hydrateSessionActivations,
  isDuplicateActivation,
  recordActivation,
  resolveSkillCatalog,
  catalogNames,
} from "../../../src/core/skills";
import { installSnapshot } from "../../../src/skills";
import { makeScratch, writeSkill } from "./helpers";

let scratch: string;

beforeEach(async () => {
  scratch = await makeScratch();
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("session activation registry", () => {
  test("records, deduplicates by content hash, hydrates, and clears", () => {
    const session = randomUUID();
    expect(getActivatedSkill(session, "alpha")).toBeUndefined();

    recordActivation(session, "alpha", "h1");
    expect(getActivatedSkill(session, "alpha")).toEqual({ name: "alpha", contentHash: "h1" });
    expect(isDuplicateActivation(session, "alpha", "h1")).toBe(true);
    expect(isDuplicateActivation(session, "alpha", "h2")).toBe(false);
    // Sessions are isolated.
    expect(isDuplicateActivation(randomUUID(), "alpha", "h1")).toBe(false);

    recordActivation(session, "alpha", "h2");
    expect(isDuplicateActivation(session, "alpha", "h1")).toBe(false);
    expect(isDuplicateActivation(session, "alpha", "h2")).toBe(true);

    hydrateSessionActivations(session, [{ name: "beta", contentHash: "h9" }]);
    expect(getActivatedSkill(session, "alpha")).toBeUndefined();
    expect(getActivatedSkill(session, "beta")).toEqual({ name: "beta", contentHash: "h9" });

    clearSessionActivations(session);
    expect(getActivatedSkill(session, "beta")).toBeUndefined();
  });
});

describe("resolveSkillCatalog", () => {
  const env = (): NodeJS.ProcessEnv => ({ VESICLE_CONFIG_DIR: join(scratch, "config") });

  test("Stage resolves an empty catalog", async () => {
    const resolved = await resolveSkillCatalog(scratch, env(), { id: "stage" });
    expect(resolved.catalog.entries).toEqual([]);
    expect(catalogNames(resolved)).toEqual([]);
  });

  test("the installed Skill Store is a model-visible source via the catalog", async () => {
    const source = await writeSkill(scratch, "alpha", { body: "Installed alpha procedure." });
    await installSnapshot({ sourceDirectory: source, env: env() });

    const resolved = await resolveSkillCatalog(scratch, env(), { id: "etl" });
    expect(resolved.catalog.entries).toEqual([{ name: "alpha", description: "alpha description", scope: "installed" }]);
    expect(catalogNames(resolved)).toEqual(["alpha"]);
    // The catalog winner resolves to the on-disk store snapshot for activation.
    const winner = resolved.byName.get("alpha");
    expect(winner?.scope).toBe("installed");
    expect(winner?.parsed.ok && winner.parsed.body).toContain("Installed alpha procedure.");
  });

  test("direct user authoring outranks an installed snapshot of the same name", async () => {
    const installedSource = await writeSkill(scratch, "alpha", { body: "Installed version." });
    await installSnapshot({ sourceDirectory: installedSource, env: env() });
    const userRoot = join(scratch, "config", "skills", "alpha");
    await mkdir(userRoot, { recursive: true });
    await Bun.write(join(userRoot, "SKILL.md"), "---\nname: alpha\ndescription: user override\n---\n\nUser version.\n");

    const resolved = await resolveSkillCatalog(scratch, env(), { id: "etl" });
    expect(resolved.catalog.entries).toEqual([{ name: "alpha", description: "user override", scope: "user" }]);
    expect(resolved.byName.get("alpha")?.scope).toBe("user");
    expect(resolved.catalog.diagnostics.some((diagnostic) => diagnostic.kind === "shadowed" && diagnostic.message.includes('"installed"'))).toBe(true);
  });

  test("a missing store snapshot degrades to a diagnostic instead of hiding other skills", async () => {
    const source = await writeSkill(scratch, "alpha", {});
    const envValue = env();
    await installSnapshot({ sourceDirectory: source, env: envValue });
    await rm(join(scratch, "config", "skill-store", "alpha"), { recursive: true, force: true });

    const resolved = await resolveSkillCatalog(scratch, envValue, { id: "etl" });
    expect(resolved.catalog.entries).toEqual([]);
    expect(resolved.catalog.diagnostics.some((diagnostic) => diagnostic.kind === "read-error")).toBe(true);
  });
});
