import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  clearSessionSkillCatalog,
  deriveSessionActivations,
  isDuplicateActivation,
  prepareSkillCompactionReattach,
  recordActivation,
  removeSessionActivations,
  clearSessionActivations,
  SKILL_CONTEXT_LOST_KIND,
  SKILL_REATTACH_KIND,
  SKILL_REATTACH_BUDGET_BYTES,
} from "../../../src/core/skills";
import { buildCompactReplacementMessages } from "../../../src/core/compact/checkpoint-installer";
import { parseCompactCheckpoint, COMPACT_CHECKPOINT_KIND } from "../../../src/core/session/compact-checkpoint";
import type { ReplacementSelection } from "../../../src/core/compact/replacement-builder";
import type { SessionRecord } from "../../../src/core/session/record-model";
import type { PortableCompactCheckpointV1 } from "../../../src/core/session/compact-checkpoint";
import { loadSkill } from "../../../src/skills";
import { makeScratch } from "./helpers";

let scratch: string;

beforeEach(async () => {
  scratch = await makeScratch();
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

const env = (): NodeJS.ProcessEnv => ({ VESICLE_CONFIG_DIR: join(scratch, "config") });

async function writeUserSkill(name: string, body: string): Promise<string> {
  const root = join(scratch, "config", "skills", name);
  await mkdir(root, { recursive: true });
  await Bun.write(join(root, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} description\n---\n\n${body}\n`);
  return root;
}

async function bodyHashOf(name: string): Promise<string> {
  const loaded = await loadSkill(join(scratch, "config", "skills", name), "user");
  if (!loaded.parsed.ok) throw new Error(`skill ${name} failed to load`);
  return loaded.parsed.bodySha256;
}

/** A tool record carrying a skill_activation event, as the recorder persists it. */
function activationToolRecord(name: string, contentHash: string): SessionRecord {
  return {
    uuid: randomUUID(),
    parentUuid: null,
    ts: new Date().toISOString(),
    sessionId: "test",
    role: "tool",
    content: "activation",
    metadata: {
      toolCallId: randomUUID(),
      ok: true,
      skillEvent: { kind: "skill_activation", name, scope: "user", contentHash, alreadyActive: false, resources: [], diagnostics: [] },
    },
  };
}

function emptySelection(): ReplacementSelection {
  return {
    sourceHeadUuid: randomUUID(),
    evictedRecords: [],
    retainedRecords: [],
    evictedLogicalTurnIds: [],
    evictedProviderRoundIds: [],
    retainedLogicalTurnIds: [],
    retainedProviderRoundIds: [],
    previousSummary: undefined,
  };
}

function checkpointPayload(replacementMessages: PortableCompactCheckpointV1["replacementMessages"], summaryText = "the summary"): PortableCompactCheckpointV1 {
  return {
    version: 1,
    strategy: "portable-summary",
    trigger: "manual",
    phase: "manual",
    reason: "requested",
    sourceHeadUuid: randomUUID(),
    createdWith: { providerId: "test", model: "test-model", engine: "etl" },
    replacementMessages,
    summary: { text: summaryText, evictedLogicalTurnIds: [], evictedProviderRoundIds: [] },
    retained: { logicalTurnIds: [], providerRoundIds: [] },
    accounting: { beforeSource: "unknown" },
  };
}

describe("prepareSkillCompactionReattach", () => {
  test("an active Skill body is reattached verbatim after compaction", async () => {
    const body = "# alpha\n\nExact procedure bytes that must survive.";
    await writeUserSkill("alpha", body);
    const loaded = await loadSkill(join(scratch, "config", "skills", "alpha"), "user");
    if (!loaded.parsed.ok) throw new Error("skill alpha failed to load");
    const contentHash = loaded.parsed.bodySha256;
    const sessionId = randomUUID();

    const result = await prepareSkillCompactionReattach({
      rootDir: scratch,
      env: env(),
      sessionId,
      profile: { id: "etl" },
      records: [activationToolRecord("alpha", contentHash)],
    });
    expect(result.lost).toEqual([]);
    expect(result.reattach.length).toBe(1);
    const message = result.reattach[0]!;
    expect(message.role).toBe("user");
    expect(message.kind).toBe(SKILL_REATTACH_KIND);
    expect(message.content).toBe(
      `The following Skill procedure remains active after compaction.\n[skill_activation name="alpha" scope="user" hash="${contentHash}" status="reattached"]\n${loaded.parsed.body}\n[/skill_activation]`,
    );
    expect(message.content).not.toContain(scratch);
    clearSessionSkillCatalog(sessionId);
  });

  test("a changed on-disk body is reported lost, never substituted", async () => {
    await writeUserSkill("alpha", "original body");
    const staleHash = "0".repeat(64);
    const sessionId = randomUUID();

    const result = await prepareSkillCompactionReattach({
      rootDir: scratch,
      env: env(),
      sessionId,
      profile: { id: "etl" },
      records: [activationToolRecord("alpha", staleHash)],
    });
    expect(result.reattach).toEqual([]);
    expect(result.lost).toEqual([{ name: "alpha", contentHash: staleHash }]);
    clearSessionSkillCatalog(sessionId);
  });

  test("the reattach budget evicts the oldest activations first", async () => {
    // Two large bodies that cannot both fit under the reattach budget.
    const body = (label: string) => `${label}\n${"x".repeat(SKILL_REATTACH_BUDGET_BYTES - 512)}`;
    await writeUserSkill("alpha", body("ALPHA-OLDEST"));
    await writeUserSkill("beta", body("BETA-NEWEST"));
    const sessionId = randomUUID();

    const result = await prepareSkillCompactionReattach({
      rootDir: scratch,
      env: env(),
      sessionId,
      profile: { id: "etl" },
      records: [
        activationToolRecord("alpha", await bodyHashOf("alpha")),
        activationToolRecord("beta", await bodyHashOf("beta")),
      ],
    });
    const totalBytes = result.reattach.reduce((sum, message) => sum + Buffer.byteLength(message.content, "utf8"), 0);
    expect(totalBytes).toBeLessThanOrEqual(SKILL_REATTACH_BUDGET_BYTES);
    // The newer activation is kept; the oldest is lost.
    expect(result.reattach.length).toBe(1);
    expect(result.reattach[0]!.content).toContain("BETA-NEWEST");
    expect(result.lost.map((lost) => lost.name)).toEqual(["alpha"]);
    clearSessionSkillCatalog(sessionId);
  });

  test("no active Skills means no reattach and no loss", async () => {
    const result = await prepareSkillCompactionReattach({
      rootDir: scratch,
      env: env(),
      sessionId: randomUUID(),
      profile: { id: "etl" },
      records: [],
    });
    expect(result).toEqual({ reattach: [], lost: [] });
  });
});

describe("reattach checkpoint durability", () => {
  test("replacement messages with reattach entries pass checkpoint validation", async () => {
    await writeUserSkill("alpha", "alpha body");
    const contentHash = await bodyHashOf("alpha");
    const sessionId = randomUUID();
    const { reattach } = await prepareSkillCompactionReattach({
      rootDir: scratch,
      env: env(),
      sessionId,
      profile: { id: "etl" },
      records: [activationToolRecord("alpha", contentHash)],
    });

    const replacement = buildCompactReplacementMessages(emptySelection(), "the summary", reattach);
    expect(replacement[0]!.kind).toBe("compact-summary");
    expect(replacement[1]!.kind).toBe(SKILL_REATTACH_KIND);
    // Strict unknown-key validation accepts the exact payload we persist.
    const parsed = parseCompactCheckpoint(checkpointPayload(replacement));
    expect(parsed.replacementMessages[1]!.content).toContain("alpha body");
    clearSessionSkillCatalog(sessionId);
  });

  test("derivation restores reattached activations after the checkpoint and honors skill-context-lost", async () => {
    await writeUserSkill("alpha", "alpha body");
    await writeUserSkill("beta", "beta body");
    const alphaHash = await bodyHashOf("alpha");
    const betaHash = await bodyHashOf("beta");
    const sessionId = randomUUID();
    const { reattach } = await prepareSkillCompactionReattach({
      rootDir: scratch,
      env: env(),
      sessionId,
      profile: { id: "etl" },
      records: [activationToolRecord("alpha", alphaHash), activationToolRecord("beta", betaHash)],
    });
    expect(reattach.length).toBe(2);

    // The pre-compaction activation records are evicted; the checkpoint is the authority.
    const checkpointRecord: SessionRecord = {
      uuid: randomUUID(),
      parentUuid: null,
      ts: new Date().toISOString(),
      sessionId: "test",
      role: "system",
      content: "Conversation compacted into a portable checkpoint.",
      metadata: { kind: COMPACT_CHECKPOINT_KIND, checkpoint: checkpointPayload(buildCompactReplacementMessages(emptySelection(), "the summary", reattach)) },
    };
    const lostRecord: SessionRecord = {
      uuid: randomUUID(),
      parentUuid: null,
      ts: new Date().toISOString(),
      sessionId: "test",
      role: "system",
      content: "Compaction lost Skill context.",
      metadata: { kind: SKILL_CONTEXT_LOST_KIND, skills: [{ name: "beta", contentHash: betaHash }] },
    };

    const derived = deriveSessionActivations([checkpointRecord, lostRecord]);
    expect(derived).toEqual([{ name: "alpha", contentHash: alphaHash }]);
    clearSessionSkillCatalog(sessionId);
  });

  test("registry removal of lost names lets reactivation proceed", async () => {
    const sessionId = randomUUID();
    recordActivation(sessionId, "alpha", "h1");
    removeSessionActivations(sessionId, ["alpha"]);
    expect(isDuplicateActivation(sessionId, "alpha", "h1")).toBe(false);
    clearSessionActivations(sessionId);
  });
});
