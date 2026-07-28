/**
 * Host-side Skill activation for the `/skill` command surface (Wave C caller).
 *
 * This is the non-model path to the same activation contract as
 * `activate_skill`: resolve through the session's frozen catalog, dedup by
 * content hash through the activation registry, and persist the exact marked
 * body block as a `skill-activation` user record so provider history, resume,
 * rewind, and compaction observe one durable activation event.
 *
 * No provider request is started here; invocation semantics (task text,
 * `--context-only`) belong to the command layer.
 */

import type { EngineProfile } from "../engine/profile";
import { createSessionStore, loadSessionSnapshot } from "../session/store";
import type { SkillDiagnostic, SkillResource, SkillScope } from "../../skills/types";
import { deriveSessionActivations } from "./activation-derivation";
import { hydrateSessionActivations, isDuplicateActivation, pruneSessionActivations, recordActivation } from "./activation-state";
import { resolveEngineEligibleCatalog, resolveSessionSkillCatalog } from "./catalog-context";
import { formatSkillActivationBlock, type ValidSkill } from "./tools";
import { SKILL_ACTIVATION_KIND } from "./types";

export type SkillActivationMode = "invoke" | "context-only";

export type ActivateSkillForSessionOptions = {
  /** Active engine profile (Stage is Skill-less and errors). */
  profile: Pick<EngineProfile, "id">;
  /** Invocation mode recorded on the activation record. Defaults to "invoke". */
  mode?: SkillActivationMode;
  /** Explicit branch parent, matching the TUI host-action append convention. */
  parentUuid?: string | null;
  /** Model context window in tokens, for the catalog budget on a fresh freeze. */
  contextWindow?: number;
};

export type HostSkillActivation = {
  name: string;
  scope: SkillScope;
  contentHash: string;
  /** True when the same name+hash was already active; nothing was appended. */
  alreadyActive: boolean;
  resources: SkillResource[];
  /** Skill-relative paths of bundled scripts (for the activation card). */
  scripts: string[];
  diagnostics: SkillDiagnostic[];
};

export async function activateSkillForSession(
  rootDir: string,
  env: NodeJS.ProcessEnv,
  sessionId: string,
  name: string,
  options: ActivateSkillForSessionOptions,
): Promise<HostSkillActivation> {
  const snapshot = await loadSessionSnapshot(rootDir, sessionId, { synthesizeDanglingToolResults: false });
  const frozen = await resolveSessionSkillCatalog(
    rootDir,
    env,
    options.profile,
    sessionId,
    snapshot.skillCatalogSnapshot,
    options.contextWindow,
  );
  const eligible = resolveEngineEligibleCatalog(frozen, options.profile);
  const skill = eligible.byName.get(name);
  if (!skill || !skill.parsed.ok) {
    const available = [...eligible.byName.keys()].join(", ") || "(none)";
    throw new Error(`Unknown skill "${name}". Available skills: ${available}.`);
  }

  // Re-derive the registry from durable history before dedup so a host
  // activation that precedes any bootstrap in this process still honors
  // activations recorded by earlier turns or processes.
  hydrateSessionActivations(sessionId, deriveSessionActivations(snapshot.records));
  pruneSessionActivations(sessionId, new Set(eligible.byName.keys()));

  const valid = skill as ValidSkill;
  const base = {
    name: valid.name,
    scope: valid.scope,
    contentHash: valid.parsed.bodySha256,
    resources: valid.parsed.resources,
    scripts: valid.parsed.resources.filter((resource) => resource.kind === "script").map((resource) => resource.path),
    diagnostics: valid.parsed.diagnostics,
  };
  if (isDuplicateActivation(sessionId, valid.name, valid.parsed.bodySha256)) {
    return { ...base, alreadyActive: true };
  }

  recordActivation(sessionId, valid.name, valid.parsed.bodySha256);
  const session = await createSessionStore(
    rootDir,
    sessionId,
    options.parentUuid !== undefined ? { parentUuid: options.parentUuid } : {},
  );
  await session.append({
    role: "user",
    content: formatSkillActivationBlock(valid, "activated"),
    metadata: {
      kind: SKILL_ACTIVATION_KIND,
      name: valid.name,
      scope: valid.scope,
      contentHash: valid.parsed.bodySha256,
      mode: options.mode ?? "invoke",
      scripts: base.scripts,
    },
  });
  return { ...base, alreadyActive: false };
}
