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
 * Drop every activation that the engine-eligible catalog no longer serves at
 * the recorded content hash: a name missing from the map, or present with a
 * different `bodySha256`, counts as inactive. This is the enforcement point of
 * the live-activation rule — an activation survives only while the frozen
 * catalog serves the same content — so a Skill re-frozen at new content by a
 * confirmed Harness migration must be activated again (its old activation
 * record stays in history as an audit trail, and dedup does not suppress the
 * reactivation). Within one frozen catalog the hash check is an identity
 * operation; it only takes effect across a catalog re-freeze.
 */
export function pruneSessionActivations(sessionId: string, eligible: ReadonlyMap<string, string>): void {
  const session = activationsBySession.get(sessionId);
  if (!session) return;
  for (const [name, contentHash] of [...session.entries()]) {
    if (eligible.get(name) !== contentHash) session.delete(name);
  }
}

/** Remove specific activations (e.g. Skills whose context compaction lost). */
export function removeSessionActivations(sessionId: string, names: readonly string[]): void {
  const session = activationsBySession.get(sessionId);
  if (!session) return;
  for (const name of names) session.delete(name);
}
