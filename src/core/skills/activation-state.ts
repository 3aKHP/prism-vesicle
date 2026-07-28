/**
 * Per-session Skill activation registry.
 *
 * Activation identity is `(sessionId, name, contentHash)`: reactivating the
 * same Skill at the same content hash deduplicates the injected body, while a
 * changed content version is a fresh activation. The registry is in-memory
 * host state (same pattern as the frozen instruction snapshot); on resume the
 * session layer re-seeds it through `hydrateSessionActivations` so dedup and
 * the prior-activation requirement for `read_skill_resource` /
 * `run_skill_script` survive a process restart.
 */

export interface ActivatedSkillEntry {
  name: string;
  contentHash: string;
}

const activationsBySession = new Map<string, Map<string, string>>();

/** The active entry for one Skill in one session, if any. */
export function getActivatedSkill(sessionId: string, name: string): ActivatedSkillEntry | undefined {
  const contentHash = activationsBySession.get(sessionId)?.get(name);
  return contentHash === undefined ? undefined : { name, contentHash };
}

/** Record one activation. A newer content hash replaces the previous entry. */
export function recordActivation(sessionId: string, name: string, contentHash: string): void {
  let session = activationsBySession.get(sessionId);
  if (!session) {
    session = new Map();
    activationsBySession.set(sessionId, session);
  }
  session.set(name, contentHash);
}

/** True when this exact `(name, contentHash)` is already active in the session. */
export function isDuplicateActivation(sessionId: string, name: string, contentHash: string): boolean {
  return activationsBySession.get(sessionId)?.get(name) === contentHash;
}

/** Drop every activation for a session (session teardown / rewind boundary). */
export function clearSessionActivations(sessionId: string): void {
  activationsBySession.delete(sessionId);
}

/**
 * Re-seed the registry after a resume from persisted activation records.
 * Replaces any existing state for the session so the hydrated set is exactly
 * what the durable history proves active.
 */
export function hydrateSessionActivations(sessionId: string, entries: readonly ActivatedSkillEntry[]): void {
  const session = new Map<string, string>();
  for (const entry of entries) session.set(entry.name, entry.contentHash);
  activationsBySession.set(sessionId, session);
}

/**
 * Drop every activation whose name is not in the eligible set. Pruned Skills
 * become simply un-activated (dedup no longer suppresses reactivation). Used
 * after hydration with the engine-eligible catalog names, which covers the
 * engine-switch rule: previously injected content stays historical, and a
 * Skill ineligible in the new Engine is inactive.
 */
export function pruneSessionActivations(sessionId: string, eligibleNames: ReadonlySet<string>): void {
  const session = activationsBySession.get(sessionId);
  if (!session) return;
  for (const name of [...session.keys()]) {
    if (!eligibleNames.has(name)) session.delete(name);
  }
}

/** Remove specific activations (e.g. Skills whose context compaction lost). */
export function removeSessionActivations(sessionId: string, names: readonly string[]): void {
  const session = activationsBySession.get(sessionId);
  if (!session) return;
  for (const name of names) session.delete(name);
}
