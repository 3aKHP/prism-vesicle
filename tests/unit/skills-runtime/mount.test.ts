import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rm, writeFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { buildCatalog } from "../../../src/skills";
import { MAX_TEXT_REFERENCE_BYTES } from "../../../src/skills/paths";
import type { ToolCall } from "../../../src/core/tools/types";
import { clearSessionActivations, eligibleCatalogHashes, executeActivateSkillTool, pruneSessionActivations, recordActivation, SkillMount } from "../../../src/core/skills";
import type { ResolvedSkillCatalog } from "../../../src/core/skills";
import { catalogFor, loadWritten, makeScratch, writeSkill } from "./helpers";

let scratch: string;
let sessionId: string;

beforeEach(async () => {
  scratch = await makeScratch();
  sessionId = randomUUID();
});

afterEach(async () => {
  clearSessionActivations(sessionId);
  await rm(scratch, { recursive: true, force: true });
});

function call(name: string, args: unknown): ToolCall {
  return { id: `call-${randomUUID()}`, name, arguments: JSON.stringify(args) };
}

async function mountedCatalog(files: Record<string, string | Uint8Array>, name = "alpha"): Promise<SkillMount> {
  const catalog = catalogFor(await loadWritten(await writeSkill(scratch, name, { files })));
  const activation = await executeActivateSkillTool(call("activate_skill", { name }), { catalog, sessionId });
  expect(activation.ok).toBe(true);
  return new SkillMount(catalog, sessionId);
}

describe("SkillMount (skills/ read-only logical root)", () => {
  test("gates every surface on prior activation with the shared instructive error", async () => {
    const catalog = catalogFor(await loadWritten(await writeSkill(scratch, "alpha", { files: { "references/note.md": "text" } })));
    const mount = new SkillMount(catalog, sessionId);
    for (const attempt of [
      () => mount.stat("skills/alpha"),
      () => mount.listDirectory("skills/alpha"),
      () => mount.grepFiles("skills/alpha", true),
      () => mount.readText("skills/alpha/references/note.md"),
      () => mount.readBytes("skills/alpha/references/note.md"),
    ]) {
      await expect(attempt()).rejects.toThrow("not active in this session");
      await expect(attempt()).rejects.toThrow('activate_skill("alpha")');
    }
  });

  test("unknown skill names list the available catalog", async () => {
    const mount = await mountedCatalog({ "references/note.md": "text" });
    await expect(mount.stat("skills/omega/references/note.md")).rejects.toThrow('Unknown skill "omega"');
  });

  test("compaction/rewind loss unmounts the skill", async () => {
    const mount = await mountedCatalog({ "references/note.md": "text" });
    clearSessionActivations(sessionId);
    await expect(mount.stat("skills/alpha")).rejects.toThrow("not active in this session");
  });

  test("an activation recorded at a stale content hash is not mounted after the re-freeze prune", async () => {
    const catalog = catalogFor(await loadWritten(await writeSkill(scratch, "alpha", { files: { "references/note.md": "text" } })));
    // The session activated "alpha" before a Harness migration re-froze the
    // catalog at its current content; the registry still holds the stale hash.
    recordActivation(sessionId, "alpha", "0".repeat(64));
    const mount = new SkillMount(catalog, sessionId);
    await expect(mount.stat("skills/alpha")).resolves.toBeDefined();
    // Bootstrap prunes activations against the re-frozen catalog's per-name
    // hashes (#298): the stale-hash activation stops counting as live.
    pruneSessionActivations(sessionId, eligibleCatalogHashes(catalog));
    await expect(mount.stat("skills/alpha")).rejects.toThrow("not active in this session");
  });

  test("rejects traversal and absolute skill-relative paths", async () => {
    const mount = await mountedCatalog({ "references/note.md": "text" });
    for (const path of ["skills/alpha/../outside.md", "skills/alpha//etc/passwd", "skills/alpha/references/./note.md"]) {
      await expect(mount.readText(path)).rejects.toThrow();
    }
  });

  test("caps mounted reads at the 256 KiB text limit with a note", async () => {
    const oversized = "a".repeat(MAX_TEXT_REFERENCE_BYTES + 100);
    const mount = await mountedCatalog({ "references/big.md": oversized });
    const read = await mount.readText("skills/alpha/references/big.md");
    expect(read.truncated).toBe(true);
    expect(read.bytes).toBe(oversized.length);
    expect(read.note).toContain("[truncated:");
    expect(read.text.length).toBeLessThanOrEqual(MAX_TEXT_REFERENCE_BYTES);
  });

  test("rejects binary resources with a redirect to view_image", async () => {
    const mount = await mountedCatalog({ "assets/blob.bin": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe]) });
    await expect(mount.readText("skills/alpha/assets/blob.bin")).rejects.toThrow("not valid UTF-8");
    // grep reads the same file lossily instead of failing the whole scan.
    const scan = await mount.grepFiles("skills/alpha/assets", true);
    expect(scan.files).toEqual(["skills/alpha/assets/blob.bin"]);
  });

  test("enumeration follows the frozen catalog inventory, reads stay live", async () => {
    const root = await writeSkill(scratch, "alpha", { files: { "references/note.md": "frozen marker", "references/gone.md": "vanishing marker" } });
    const catalog = catalogFor(await loadWritten(root));
    await executeActivateSkillTool(call("activate_skill", { name: "alpha" }), { catalog, sessionId });
    const mount = new SkillMount(catalog, sessionId);

    const latePath = join(root, "references", "late.md");
    await mkdir(dirname(latePath), { recursive: true });
    await writeFile(latePath, "late marker", "utf8");
    await rm(join(root, "references", "gone.md"));

    const listing = await mount.listDirectory("skills/alpha/references");
    expect(listing?.entries.map((entry) => entry.path)).toEqual(["skills/alpha/references/note.md"]);
    // The vanished inventory entry is omitted and that omission is disclosed.
    expect(listing?.truncated).toBe(true);
    const scan = await mount.grepFiles("skills/alpha", true);
    expect(scan.files).toEqual(["skills/alpha/SKILL.md", "skills/alpha/references/note.md"]);
    expect(scan.notes.join(" ")).toContain("skills/alpha/references/gone.md");
    expect(scan.notes.join(" ")).toContain("missing from the skill root");
    // Live resolution mirrors read_skill_resource: a post-freeze file is
    // readable when addressed directly even though it is not enumerated.
    const read = await mount.readText("skills/alpha/references/late.md");
    expect(read.text).toBe("late marker");
  });

  test("grep scan set: recursive=false keeps immediate children, oversized files are skipped with a note", async () => {
    const mount = await mountedCatalog({
      "references/deep/inner.md": "inner",
      "references/top.md": "top",
      "references/huge.md": "b".repeat(MAX_TEXT_REFERENCE_BYTES + 1),
    });
    expect((await mount.grepFiles("skills/alpha/references", false)).files).toEqual([
      "skills/alpha/references/top.md",
    ]);
    const recursive = await mount.grepFiles("skills/alpha/references", true);
    expect(recursive.files).toEqual(["skills/alpha/references/deep/inner.md", "skills/alpha/references/top.md"]);
    expect(recursive.notes.join(" ")).toContain("skills/alpha/references/huge.md");
    expect(recursive.notes.join(" ")).toContain("exceeds the");
    // A single-file target is honored regardless of recursion.
    expect((await mount.grepFiles("skills/alpha/references/deep/inner.md", false)).files).toEqual([
      "skills/alpha/references/deep/inner.md",
    ]);
    await expect(mount.grepFiles("skills/alpha/references/missing.md", true)).rejects.toThrow("not a mounted Skill file");
  });

  test("resolves the catalog winner, never a shadowed copy", async () => {
    const winnerRoot = await writeSkill(scratch, "alpha", { files: { "references/note.md": "winner marker" } });
    const winner = await loadWritten(winnerRoot);
    // A same-named loser in a different root: never merged into the catalog.
    const loserRoot = join(scratch, "loser-root");
    await mkdir(join(loserRoot, "references"), { recursive: true });
    await writeFile(join(loserRoot, "references", "note.md"), "loser marker", "utf8");
    await writeFile(join(loserRoot, "SKILL.md"), "---\nname: alpha\ndescription: loser\n---\n\nloser\n", "utf8");
    const catalog: ResolvedSkillCatalog = {
      catalog: buildCatalog([winner]),
      byName: new Map([[winner.name, winner]]),
    };
    await executeActivateSkillTool(call("activate_skill", { name: "alpha" }), { catalog, sessionId });
    const mount = new SkillMount(catalog, sessionId);
    const scan = await mount.grepFiles("skills/alpha", true);
    expect(scan.files).toContain("skills/alpha/references/note.md");
    const read = await mount.readText("skills/alpha/references/note.md");
    expect(read.text).toBe("winner marker");
  });

  test("lists activated skills at the mount root in catalog order", async () => {
    const first = await loadWritten(await writeSkill(scratch, "zeta", { files: { "references/note.md": "z" } }));
    const second = await loadWritten(await writeSkill(scratch, "beta", { files: { "references/note.md": "b" } }));
    const catalog: ResolvedSkillCatalog = {
      catalog: buildCatalog([first, second]),
      byName: new Map([
        [first.name, first],
        [second.name, second],
      ]),
    };
    await executeActivateSkillTool(call("activate_skill", { name: "beta" }), { catalog, sessionId });
    const mount = new SkillMount(catalog, sessionId);
    const listing = await mount.listDirectory("skills");
    expect(listing?.entries.map((entry) => entry.path)).toEqual(["skills/beta"]);
    expect(await mount.stat("skills")).toMatchObject({ type: "directory" });
    // A catalog entry that is not activated stays gated, not silently absent.
    await expect(mount.stat("skills/zeta")).rejects.toThrow("not active in this session");
  });
});
