/**
 * Effective Skill catalog: the bounded, frozen routing view derived from
 * discovery winners.
 *
 * The catalog exposes only routing data (`name`, `description`, safe `scope`)
 * and never an absolute host path. Research §4 caps the complete catalog to
 * ~2% of the model context window when known, or an 8 KiB fallback, preferring
 * description shortening and then omission of lowest-precedence skills so a
 * large inventory cannot silently crowd out Engine context.
 *
 * The catalog hash is an identity fingerprint over the KEPT skills'
 * `name\0scope\0contentSha256`. Description shortening (mutable routing data)
 * does not change it, but activating, omitting, or changing the content version
 * of a skill does. Phase 0 builds and hashes the catalog; it is not yet
 * model-visible (no activation in this phase).
 */

import { createHash } from "node:crypto";
import { PHASE0_PRECEDENCE } from "./discovery";
import type { LoadedSkill, SkillCatalog, SkillCatalogEntry, SkillDiagnostic, SkillScope } from "./types";

const FALLBACK_BUDGET_BYTES = 8 * 1024;
const SHORTENED_DESCRIPTION_CHARS = 160;
const MIN_DESCRIPTION_CHARS = 80;
/** Bytes-per-token approximation, matching the compaction estimator's `ceil(bytes/2)`. */
const BYTES_PER_TOKEN = 2;

export interface BuildCatalogOptions {
  /** Model context window in tokens, if known. */
  contextWindow?: number;
  /** Explicit byte budget override (used by tests). */
  budgetBytes?: number;
}

interface Candidate {
  entry: SkillCatalogEntry;
  scope: SkillScope;
  bodySha256: string;
  precedenceRank: number;
  originalDescription: string;
}

/**
 * Build the effective catalog from discovery winners. Winners are
 * `LoadedSkill` values whose parsed result is valid (`discovery.skills`).
 */
export function buildCatalog(skills: readonly LoadedSkill[], options: BuildCatalogOptions = {}): SkillCatalog {
  const budget = options.budgetBytes ?? deriveBudgetBytes(options.contextWindow);
  const candidates = skills
    .map(toCandidate)
    .sort((left, right) => left.entry.name.localeCompare(right.entry.name));

  const kept = applyBudget(candidates, budget);
  // `applyBudget` may return new Candidate objects (shortened/minimal), so
  // compare by stable identity (name + scope), never by object reference.
  const keptIds = new Set(kept.map(candidateId));
  const omitted: SkillCatalog["omitted"] = candidates
    .filter((candidate) => !keptIds.has(candidateId(candidate)))
    .map((candidate) => ({ name: candidate.entry.name, scope: candidate.scope, reason: "omitted to respect the catalog budget" }));
  const diagnostics: SkillDiagnostic[] = [];
  if (omitted.length > 0) {
    diagnostics.push({
      kind: "invalid",
      message: `${omitted.length} skill(s) omitted to respect the ${budget}-byte catalog budget.`,
    });
  }

  const entries = kept.map((candidate) => candidate.entry).sort((left, right) => left.name.localeCompare(right.name));
  return {
    entries,
    hash: computeCatalogHash(kept),
    omitted,
    diagnostics,
  };
}

function toCandidate(skill: LoadedSkill): Candidate {
  if (!skill.parsed.ok) {
    // Callers pass discovery winners, which are always valid. Guard anyway.
    throw new Error(`Cannot catalog invalid skill "${skill.name}".`);
  }
  return {
    entry: { name: skill.name, description: skill.parsed.metadata.description, scope: skill.scope },
    scope: skill.scope,
    bodySha256: skill.parsed.bodySha256,
    precedenceRank: precedenceRank(skill.scope),
    originalDescription: skill.parsed.metadata.description,
  };
}

/**
 * Respect the byte budget: first shorten descriptions (160, then 80 chars),
 * then omit lowest-precedence candidates (highest rank first; within a rank,
 * later name first) until the rendered catalog fits. Never empties the catalog
 * below one entry; if a single min-shortened entry still exceeds the budget it
 * is retained with its short form so activation remains possible.
 */
function applyBudget(candidates: readonly Candidate[], budget: number): Candidate[] {
  if (catalogBytes(candidates) <= budget) return [...candidates];

  const shortened = candidates.map((candidate) => withDescription(candidate, SHORTENED_DESCRIPTION_CHARS));
  if (catalogBytes(shortened) <= budget) return shortened;

  const minimal = candidates.map((candidate) => withDescription(candidate, MIN_DESCRIPTION_CHARS));
  if (catalogBytes(minimal) <= budget) return minimal;

  const omissionOrder = [...minimal].sort((left, right) => {
    if (left.precedenceRank !== right.precedenceRank) return right.precedenceRank - left.precedenceRank;
    return right.entry.name.localeCompare(left.entry.name);
  });
  const kept = [...minimal];
  for (const candidate of omissionOrder) {
    if (catalogBytes(kept) <= budget) break;
    if (kept.length === 1) break;
    const index = kept.indexOf(candidate);
    if (index >= 0) kept.splice(index, 1);
  }
  return kept;
}

/** Stable identity for a candidate, independent of description shortening. */
function candidateId(candidate: Candidate): string {
  return `${candidate.entry.name}\0${candidate.scope}`;
}

function withDescription(candidate: Candidate, maxChars: number): Candidate {
  const trimmed = truncate(candidate.originalDescription, maxChars);
  return {
    ...candidate,
    entry: { ...candidate.entry, description: trimmed },
  };
}

function truncate(value: string, maxChars: number): string {
  const chars = [...value];
  if (chars.length <= maxChars) return value;
  return `${chars.slice(0, Math.max(1, maxChars - 1)).join("")}…`;
}

function catalogBytes(candidates: readonly Candidate[]): number {
  return candidates.reduce((sum, candidate) => sum + Buffer.byteLength(`${candidate.entry.name}\n${candidate.entry.description}\n${candidate.entry.scope}\n`, "utf8"), 0);
}

function computeCatalogHash(candidates: readonly Candidate[]): string {
  const payload = [...candidates]
    .sort((left, right) => left.entry.name.localeCompare(right.entry.name))
    .map((candidate) => `${candidate.entry.name}\0${candidate.scope}\0${candidate.bodySha256}`)
    .join("\n");
  return createHash("sha256").update(payload).digest("hex");
}

function deriveBudgetBytes(contextWindow: number | undefined): number {
  if (typeof contextWindow !== "number" || contextWindow <= 0) return FALLBACK_BUDGET_BYTES;
  return Math.max(1, Math.floor(contextWindow * 0.02)) * BYTES_PER_TOKEN;
}

function precedenceRank(scope: SkillScope): number {
  const rank = PHASE0_PRECEDENCE.indexOf(scope);
  return rank === -1 ? Number.MAX_SAFE_INTEGER : rank;
}
