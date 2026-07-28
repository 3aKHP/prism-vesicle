/**
 * Derive the durable Skill activation set from session records.
 *
 * Bootstrap runs this at every turn and hydrates the in-memory registry with
 * the result, so resume, rewind (a snapshot at an older head), and compaction
 * stay automatically consistent with what the append-only history proves.
 *
 * Sources, in order:
 * - the latest compact checkpoint resets the set to its
 *   `skill-activation-reattach` replacement messages (activations whose
 *   records were evicted survive only as reattach payloads);
 * - after that checkpoint, tool records with a `skill_activation` skillEvent
 *   and host-injected `skill-activation` user records (latest per name wins);
 * - `skill-context-lost` system notices remove names (compaction dropped the
 *   body; the Skill must be reactivated and dedup must not suppress it).
 */

import { COMPACT_CHECKPOINT_KIND, parseCompactCheckpoint } from "../session/compact-checkpoint";
import type { SessionRecord } from "../session/record-model";
import type { ActivatedSkillEntry } from "./activation-state";
import { SKILL_ACTIVATION_KIND, SKILL_CONTEXT_LOST_KIND, SKILL_REATTACH_KIND } from "./types";

const REATTACH_MARKER = /^\[skill_activation name="([^"]+)" scope="[^"]*" hash="([a-f0-9]{64})" status="reattached"\]$/m;

export function deriveSessionActivations(records: readonly SessionRecord[]): ActivatedSkillEntry[] {
  const byName = new Map<string, string>();
  let startIndex = 0;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (record.role !== "system" || record.metadata?.kind !== COMPACT_CHECKPOINT_KIND) continue;
    byName.clear();
    const checkpoint = parseCompactCheckpoint(record.metadata.checkpoint);
    for (const message of checkpoint.replacementMessages) {
      if (message.kind !== SKILL_REATTACH_KIND) continue;
      const marker = REATTACH_MARKER.exec(message.content);
      if (marker) byName.set(marker[1]!, marker[2]!);
    }
    startIndex = index + 1;
  }

  for (let index = startIndex; index < records.length; index += 1) {
    const record = records[index]!;
    if (record.role === "tool") {
      const event = record.metadata?.skillEvent;
      if (event && typeof event === "object" && (event as { kind?: unknown }).kind === "skill_activation") {
        const { name, contentHash } = event as { name?: unknown; contentHash?: unknown };
        if (typeof name === "string" && typeof contentHash === "string") byName.set(name, contentHash);
      }
      continue;
    }
    if (record.role === "user" && record.metadata?.kind === SKILL_ACTIVATION_KIND) {
      const name = record.metadata.name;
      const contentHash = record.metadata.contentHash;
      if (typeof name === "string" && typeof contentHash === "string") byName.set(name, contentHash);
      continue;
    }
    if (record.role === "system" && record.metadata?.kind === SKILL_CONTEXT_LOST_KIND) {
      const skills = record.metadata.skills;
      if (!Array.isArray(skills)) continue;
      for (const entry of skills) {
        const name = (entry as { name?: unknown })?.name;
        if (typeof name === "string") byName.delete(name);
      }
    }
  }
  return [...byName].map(([name, contentHash]) => ({ name, contentHash }));
}
