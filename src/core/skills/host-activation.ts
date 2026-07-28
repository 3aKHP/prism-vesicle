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
import { createSessionStore, loadSessionSnapshot, withSessionActivationLock } from "../session/store";
import type { SkillDiagnostic, SkillResource, SkillScope } from "../../skills/types";
import { deriveSessionActivations } from "./activation-derivation";
import { hydrateSessionActivations, isDuplicateActivation, pruneSessionActivations, recordActivation } from "./activation-state";
import { resolveEngineEligibleCatalog, resolveSessionSkillCatalog } from "./catalog-context";
import { formatSkillActivationBlock, type ValidSkill } from "./tools";
import { SKILL_ACTIVATION_KIND } from "./types";
import type { ResolveFilesystemSkillsOptions } from "./catalog-sources";

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
  /** Narrow test-only overrides for filesystem source resolution. */
  filesystemOptions?: ResolveFilesystemSkillsOptions;
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
  /** UUID of the appended activation record; absent when alreadyActive. */
  recordUuid?: string;
};

async function loadSnapshotOrUndefined(
  rootDir: string,
  sessionId: string,
): Promise<Awaited<ReturnType<typeof loadSessionSnapshot>> | undefined> {
  try {
    return await loadSessionSnapshot(rootDir, sessionId, { synthesizeDanglingToolResults: false });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return undefined;
  }
}

const activationTails = new Map<string, Promise<unknown>>();

/**
 * Serialize the hydrate/dedup/append/registry-update critical section per
 * session (mirrors append-store's per-path tail). Without this, two concurrent
 * identical activations both pass the hash dedup check before either records
 * itself, appending the activation twice. A rejection does not poison the
 * chain, and the tail entry is dropped once it is no longer the active tail.
 */
function serializeActivation<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
  const previous = activationTails.get(sessionId) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(operation);
  const tail = result.then(() => undefined, () => undefined);
  activationTails.set(sessionId, tail);
  void tail.finally(() => {
    if (activationTails.get(sessionId) === tail) activationTails.delete(sessionId);
  });
  return result;
}

export async function activateSkillForSession(
  rootDir: string,
  env: NodeJS.ProcessEnv,
  sessionId: string,
  name: string,
  options: ActivateSkillForSessionOptions,
): Promise<HostSkillActivation> {
  const snapshot = await loadSnapshotOrUndefined(rootDir, sessionId);
  const frozen = await resolveSessionSkillCatalog(
    rootDir,
    env,
    options.profile,
    sessionId,
    snapshot?.skillCatalogSnapshot,
    options.contextWindow,
    options.filesystemOptions,
  );
  const eligible = resolveEngineEligibleCatalog(frozen, options.profile);
  const skill = eligible.byName.get(name);
  if (!skill || !skill.parsed.ok) {
    const available = [...eligible.byName.keys()].join(", ") || "(none)";
    throw new Error(`Unknown skill "${name}". Available skills: ${available}.`);
  }

  const valid = skill as ValidSkill;
  const base = {
    name: valid.name,
    scope: valid.scope,
    contentHash: valid.parsed.bodySha256,
    resources: valid.parsed.resources,
    scripts: valid.parsed.resources.filter((resource) => resource.kind === "script").map((resource) => resource.path),
    diagnostics: valid.parsed.diagnostics,
  };

  return serializeActivation(sessionId, () =>
    withSessionActivationLock(rootDir, sessionId, async () => {
      // Re-read durable state under the per-session lock so an activation
      // appended by a just-completed concurrent call — in this process or
      // another — is visible to dedup; re-derive the registry from it so a host
      // activation that precedes any bootstrap still honors activations recorded
      // by earlier turns or processes.
      const fresh = await loadSnapshotOrUndefined(rootDir, sessionId);
      hydrateSessionActivations(sessionId, deriveSessionActivations(fresh?.records ?? []));
      pruneSessionActivations(sessionId, new Set(eligible.byName.keys()));
      if (isDuplicateActivation(sessionId, valid.name, valid.parsed.bodySha256)) {
        return { ...base, alreadyActive: true };
      }

      const session = await createSessionStore(
        rootDir,
        sessionId,
        options.parentUuid !== undefined ? { parentUuid: options.parentUuid } : {},
      );
      const appended = await session.append({
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
      // Mark the registry only after the durable append succeeds so a failed
      // append leaves no entry that would misclassify a retry as a duplicate.
      recordActivation(sessionId, valid.name, valid.parsed.bodySha256);
      return { ...base, alreadyActive: false, recordUuid: appended.uuid };
    }),
  );
}
