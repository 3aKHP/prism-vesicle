/**
 * Persisted Skill catalog snapshot: the bounded, durable identity of the
 * catalog a session froze at bootstrap.
 *
 * The snapshot is session metadata, so it stays deliberately small: catalog
 * hash, per-entry `name`/`scope`/`bodySha256`, and counts. It never carries
 * bodies, descriptions, or absolute host paths. Resume re-resolves the store
 * and keeps only entries whose hash still matches (`catalog-context.ts`), so a
 * changed on-disk Skill is never silently substituted for the content the
 * conversation already used.
 */

import type { SkillScope } from "../../skills/types";
import type { ResolvedSkillCatalog } from "./catalog";

export interface SkillCatalogSnapshotEntry {
  name: string;
  scope: SkillScope;
  /** SHA-256 of the `SKILL.md` body (without frontmatter) the session froze. */
  bodySha256: string;
}

export interface SkillCatalogSnapshot {
  catalogHash: string;
  entries: SkillCatalogSnapshotEntry[];
  omittedCount: number;
  diagnosticsCount: number;
}

/** Project the resolved catalog into its persisted snapshot shape. */
export function snapshotSkillCatalog(resolved: ResolvedSkillCatalog): SkillCatalogSnapshot {
  const entries: SkillCatalogSnapshotEntry[] = [];
  for (const entry of resolved.catalog.entries) {
    const skill = resolved.byName.get(entry.name);
    if (!skill || !skill.parsed.ok) continue;
    entries.push({ name: entry.name, scope: entry.scope, bodySha256: skill.parsed.bodySha256 });
  }
  return {
    catalogHash: resolved.catalog.hash,
    entries,
    omittedCount: resolved.catalog.omitted.length,
    diagnosticsCount: resolved.catalog.diagnostics.length,
  };
}

/** True when a snapshot carries anything worth persisting. */
export function isMeaningfulSkillCatalogSnapshot(snapshot: SkillCatalogSnapshot): boolean {
  return snapshot.entries.length > 0 || snapshot.diagnosticsCount > 0;
}

/**
 * Defensively parse a persisted snapshot from session metadata. Returns
 * undefined for any shape mismatch rather than throwing: a malformed snapshot
 * degrades to a fresh resolution, never to a session load failure.
 */
export function parseSkillCatalogSnapshot(value: unknown): SkillCatalogSnapshot | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  if (typeof source.catalogHash !== "string" || source.catalogHash.length === 0) return undefined;
  if (!Array.isArray(source.entries)) return undefined;
  const entries: SkillCatalogSnapshotEntry[] = [];
  for (const raw of source.entries) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const entry = raw as Record<string, unknown>;
    if (typeof entry.name !== "string" || entry.name.length === 0) return undefined;
    if (typeof entry.scope !== "string" || !SKILL_SCOPES.has(entry.scope as SkillScope)) return undefined;
    if (typeof entry.bodySha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.bodySha256)) return undefined;
    entries.push({ name: entry.name, scope: entry.scope as SkillScope, bodySha256: entry.bodySha256 });
  }
  if (typeof source.omittedCount !== "number" || !Number.isInteger(source.omittedCount) || source.omittedCount < 0) return undefined;
  if (typeof source.diagnosticsCount !== "number" || !Number.isInteger(source.diagnosticsCount) || source.diagnosticsCount < 0) return undefined;
  return {
    catalogHash: source.catalogHash,
    entries,
    omittedCount: source.omittedCount,
    diagnosticsCount: source.diagnosticsCount,
  };
}

const SKILL_SCOPES = new Set<SkillScope>(["harness", "user", "host", "project", "installed"]);
