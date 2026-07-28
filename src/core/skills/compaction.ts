/**
 * Compaction support for active Skill procedure context.
 *
 * Compaction must not silently erase an active Skill body: every Skill the
 * durable history proves active at the compaction head is reattached as a
 * `skill-activation-reattach` user message inside the replacement history, or
 * — when the exact body can no longer be resolved or the reattach budget is
 * exhausted — reported as lost so the runtime can require reactivation.
 *
 * Bodies come only from the session's frozen catalog (or the persisted
 * snapshot re-resolution), hash-checked against the recorded activation: a
 * changed on-disk Skill is never reattached as if it were the old version.
 */

import type { EngineProfile } from "../engine/profile";
import type { ResumedMessage } from "../session/store";
import type { SessionRecord } from "../session/record-model";
import { deriveSessionActivations } from "./activation-derivation";
import { resolveEngineEligibleCatalog, resolveSessionSkillCatalog } from "./catalog-context";
import type { SkillCatalogSnapshot } from "./catalog-snapshot";
import { formatSkillActivationBlock, type ValidSkill } from "./tools";
import { SKILL_REATTACH_KIND } from "./types";

/** Total byte budget for all reattach payloads inside one compact checkpoint. */
export const SKILL_REATTACH_BUDGET_BYTES = 16 * 1024;

const REATTACH_PREFIX = "The following Skill procedure remains active after compaction.";

export type SkillContextLoss = { name: string; contentHash: string };

export type SkillCompactionReattach = {
  /** User messages to insert between the compact summary and the retained messages. */
  reattach: ResumedMessage[];
  /** Active Skills whose exact body could not be retained (require reactivation). */
  lost: SkillContextLoss[];
};

export async function prepareSkillCompactionReattach(params: {
  rootDir: string;
  env: NodeJS.ProcessEnv;
  sessionId: string;
  profile: Pick<EngineProfile, "id">;
  /** Active-branch records at the compaction source head. */
  records: readonly SessionRecord[];
  persistedSnapshot?: SkillCatalogSnapshot;
  contextWindow?: number;
}): Promise<SkillCompactionReattach> {
  const active = deriveSessionActivations(params.records);
  if (active.length === 0) return { reattach: [], lost: [] };

  const frozen = await resolveSessionSkillCatalog(
    params.rootDir,
    params.env,
    params.profile,
    params.sessionId,
    params.persistedSnapshot,
    params.contextWindow,
  );
  const eligible = resolveEngineEligibleCatalog(frozen, params.profile);

  const lost: SkillContextLoss[] = [];
  const candidates: Array<{ entry: SkillContextLoss; message: ResumedMessage }> = [];
  for (const entry of active) {
    const skill = eligible.byName.get(entry.name);
    if (!skill || !skill.parsed.ok || skill.parsed.bodySha256 !== entry.contentHash) {
      // The exact activated body is unavailable (Skill changed/removed or not
      // eligible in this Engine) — never substitute different content.
      lost.push(entry);
      continue;
    }
    candidates.push({
      entry,
      message: {
        role: "user",
        kind: SKILL_REATTACH_KIND,
        content: `${REATTACH_PREFIX}\n${formatSkillActivationBlock(skill as ValidSkill, "reattached")}`,
      },
    });
  }

  // Budget: evict the oldest activations first, keeping the newest within
  // SKILL_REATTACH_BUDGET_BYTES. Candidates are oldest→newest; walk backwards.
  let bytes = 0;
  const kept: ResumedMessage[] = [];
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index]!;
    const cost = Buffer.byteLength(candidate.message.content, "utf8");
    if (bytes + cost > SKILL_REATTACH_BUDGET_BYTES) {
      lost.unshift(candidate.entry);
      continue;
    }
    bytes += cost;
    kept.unshift(candidate.message);
  }
  return { reattach: kept, lost };
}
