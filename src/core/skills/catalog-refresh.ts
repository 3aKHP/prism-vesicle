/**
 * Explicit session Skill-catalog re-freeze (#308).
 *
 * The frozen-catalog contract pins a session to the exact content it started
 * with: resume re-resolves by name+hash and drops mismatches rather than
 * silently substituting bodies. Before this module the only write paths for a
 * new snapshot were the Harness migration record and the one-time backfill
 * for legacy sessions recorded before freezing existed, so a Skill whose body
 * drifted without a Harness identity change left the catalog permanently and
 * `/skill <name>` could never see it again.
 *
 * - `computeSkillCatalogDrift` is the pure diff between a session's persisted
 *   snapshot and the current installation — the same computation the migration
 *   preflight reports — reusable by advisory surfaces that must not write.
 * - `refreshSessionSkillCatalog` persists the fresh snapshot as an append-only
 *   `skill-catalog` record (just another `metadata.skills` carrier the
 *   session-level host-state projection resolves latest-wins, identical for
 *   every branch head) and drops the in-process freeze so the next bootstrap
 *   re-resolves by the new hashes. Old-hash activations retire through the
 *   existing name+hash prune; nothing is rewritten and no old record is
 *   removed.
 *
 * The context-window budget follows the session's recorded provider selection
 * through `loadConfigForSelection` (two-level fallback, like the migration
 * preflight) — the same selection the next bootstrap re-resolves with, keeping
 * the refresh and the bootstrap budgets aligned. Freezing under any other
 * budget would let the next bootstrap's re-resolution drop entries this
 * refresh just froze.
 */

import { loadConfigWithProviderFallback } from "../../config/providers";
import type { EngineProfile } from "../engine/profile";
import type { SessionRecord } from "../session/record-model";
import { createSessionStore, loadSessionSnapshot } from "../session/store";
import { deriveSessionActivations } from "./activation-derivation";
import { resolveSkillCatalog } from "./catalog";
import type { ResolvedSkillCatalog } from "./catalog";
import type { ResolveFilesystemSkillsOptions } from "./catalog-sources";
import { clearSessionSkillCatalog } from "./catalog-context";
import { isMeaningfulSkillCatalogSnapshot, snapshotSkillCatalog } from "./catalog-snapshot";
import type { SkillCatalogSnapshot } from "./catalog-snapshot";
import { SKILL_CATALOG_RECORD_KIND } from "./types";

export type SkillCatalogDriftEvent =
  | { kind: "removed"; name: string }
  | { kind: "changed"; name: string; mustReactivate: boolean };

export type SkillCatalogDrift = {
  /** The fresh resolution the drift was computed against (a re-freeze persists its snapshot). */
  catalog: ResolvedSkillCatalog;
  /** The snapshot a re-freeze would persist: what a brand-new session would freeze now. */
  snapshot: SkillCatalogSnapshot;
  /**
   * Per persisted-entry events in snapshot order: `removed` no longer resolves
   * under the current installation; `changed` resolves at a different body
   * hash (`mustReactivate` when a live activation sits at the stale hash).
   * Scope-only moves are not drift, matching the migration preflight's
   * body-hash comparison.
   */
  events: SkillCatalogDriftEvent[];
  /** Fresh entries the persisted snapshot never froze. */
  added: string[];
  /** Stale-hash activations whose Skill still resolves fresh; they must be activated again. */
  reactivate: string[];
  /** Whether the session had a persisted snapshot at all (legacy sessions did not). */
  persisted: boolean;
};

export async function computeSkillCatalogDrift(options: {
  rootDir: string;
  env: NodeJS.ProcessEnv;
  profile: Pick<EngineProfile, "id">;
  contextWindow?: number;
  persistedSnapshot?: SkillCatalogSnapshot;
  records: readonly SessionRecord[];
  filesystemOptions?: ResolveFilesystemSkillsOptions;
}): Promise<SkillCatalogDrift> {
  const catalog = await resolveSkillCatalog(
    options.rootDir,
    options.env,
    options.profile,
    options.contextWindow,
    options.filesystemOptions,
  );
  const snapshot = snapshotSkillCatalog(catalog);
  const freshByName = new Map(snapshot.entries.map((entry) => [entry.name, entry]));
  const staleActivationNames = new Set(
    deriveSessionActivations(options.records)
      .filter((activation) => freshByName.get(activation.name)?.bodySha256 !== activation.contentHash)
      .map((activation) => activation.name),
  );
  const persistedNames = new Set((options.persistedSnapshot?.entries ?? []).map((entry) => entry.name));
  const added = snapshot.entries.filter((entry) => !persistedNames.has(entry.name)).map((entry) => entry.name);
  const events: SkillCatalogDriftEvent[] = [];
  for (const entry of options.persistedSnapshot?.entries ?? []) {
    const fresh = freshByName.get(entry.name);
    if (!fresh) {
      events.push({ kind: "removed", name: entry.name });
    } else if (fresh.bodySha256 !== entry.bodySha256) {
      events.push({ kind: "changed", name: entry.name, mustReactivate: staleActivationNames.has(entry.name) });
    }
  }
  const reactivate = [...staleActivationNames].filter((name) => freshByName.has(name)).sort();
  return { catalog, snapshot, events, added, reactivate, persisted: options.persistedSnapshot !== undefined };
}

export type SessionSkillCatalogRefresh = {
  drift: SkillCatalogDrift;
  /** False for the idempotent no-op: no drift and the session already froze exactly this catalog. */
  appended: boolean;
  /**
   * True when no provider configuration could be loaded at all, so the fresh
   * snapshot was frozen without any context-window budget. A later refresh
   * under a loadable config re-freezes under the real budget.
   */
  unbudgeted: boolean;
};

export async function refreshSessionSkillCatalog(options: {
  rootDir: string;
  env: NodeJS.ProcessEnv;
  sessionId: string;
  filesystemOptions?: ResolveFilesystemSkillsOptions;
}): Promise<SessionSkillCatalogRefresh> {
  const snapshot = await loadSessionSnapshot(options.rootDir, options.sessionId, {
    synthesizeDanglingToolResults: false,
  });
  const config = await loadConfigWithProviderFallback(snapshot.providerSelection, options.env);
  const drift = await computeSkillCatalogDrift({
    rootDir: options.rootDir,
    env: options.env,
    // The session's recorded Engine, the same one the next bootstrap
    // resolves under — not the engine the TUI happens to be showing.
    profile: { id: snapshot.engine ?? "etl" },
    ...(config?.limits?.contextWindow !== undefined ? { contextWindow: config.limits.contextWindow } : {}),
    ...(snapshot.skillCatalogSnapshot ? { persistedSnapshot: snapshot.skillCatalogSnapshot } : {}),
    records: snapshot.records,
    ...(options.filesystemOptions ? { filesystemOptions: options.filesystemOptions } : {}),
  });
  // A legacy session that never froze a catalog still deserves a durable
  // freeze (the resume backfill would write the same record); a session whose
  // snapshot already matches the installation gets no record at all.
  const shouldAppend =
    drift.events.length > 0 ||
    drift.added.length > 0 ||
    (!drift.persisted && isMeaningfulSkillCatalogSnapshot(drift.snapshot));
  if (!shouldAppend) return { drift, appended: false, unbudgeted: config === undefined };

  const session = await createSessionStore(options.rootDir, options.sessionId);
  await session.append({
    role: "system",
    content: "Skill catalog re-frozen at the current installation content.",
    metadata: { kind: SKILL_CATALOG_RECORD_KIND, skills: drift.snapshot },
  });
  // Same ordering contract as the migration commit: only after the durable
  // append succeeds, drop the in-process freeze so any later resolution in
  // this process re-reads the new persisted snapshot.
  clearSessionSkillCatalog(options.sessionId);
  return { drift, appended: true, unbudgeted: config === undefined };
}
