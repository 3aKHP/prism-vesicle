/**
 * Shared types for the Skills runtime.
 *
 * A Skill is on-demand procedural context plus bundled resources, never an
 * Engine, Agent Profile, MCP server, or permission grant. It may contain
 * scripts but cannot itself widen the effective tool or permission surface.
 * See `docs/dev/SKILLS.md` for the runtime boundary and
 * `dev/docs/working/SKILLS_RUNTIME_RESEARCH_AND_FEASIBILITY.md` for the
 * approved implementation plan and research basis.
 *
 * Diagnostic and catalog shapes never carry an absolute host path: discovery
 * surfaces only logical source scopes and skill-relative paths. Physical paths
 * are host implementation details, not part of the portable Skill contract.
 */

/**
 * Logical discovery scope label. Phase 0 implements `harness` and `user`.
 * Future scopes (`host`-bundled, `project` under `.agents/skills/`, `installed`
 * snapshots from the Skill Store) are reserved here so catalog and diagnostic
 * consumers handle one closed set.
 */
export type SkillScope = "harness" | "user" | "host" | "project" | "installed";

/**
 * The active filesystem discovery scopes. Phase 0 shipped `harness` and `user`;
 * Phase 3 adds `project` (`.agents/skills/`). The `installed` scope is resolved
 * separately by the session catalog from the Skill Store, not by filesystem
 * discovery. This const controls which scopes are iterated during discovery;
 * collision resolution order is governed by `DISCOVERY_PRECEDENCE` in
 * `discovery.ts`. Both must be updated together when adding a new scope.
 */
export const DISCOVERY_SCOPES: readonly SkillScope[] = ["harness", "user", "project"];

/**
 * Stable diagnostic identifiers. `message` is human-readable and carries no
 * absolute host path; tests and `vesicle doctor` categorize on `kind`.
 */
export type SkillDiagnosticKind =
  | "missing-frontmatter"
  | "missing-closing-fence"
  | "invalid-utf8"
  | "oversized-skill"
  | "name-missing"
  | "name-invalid"
  | "name-directory-mismatch"
  | "description-missing"
  | "description-empty"
  | "description-oversized"
  | "unsupported-field"
  | "allowed-tools-ignored"
  | "resource-path-unsafe"
  | "resource-symlink"
  | "resource-oversized"
  | "resource-count-oversize"
  | "parse-error"
  | "not-a-regular-file"
  | "linked-root"
  | "read-error"
  | "shadowed"
  | "invalid";

export interface SkillDiagnostic {
  kind: SkillDiagnosticKind;
  /** Human-readable detail. Must not include an absolute host path. */
  message: string;
}

/**
 * Portable Agent Skills metadata: the validated subset of the open standard's
 * `SKILL.md` frontmatter. Unknown frontmatter fields are preserved on
 * `unknownFields` for inspection but have no runtime behavior.
 */
export interface SkillMetadata {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  /** String-to-string map. Non-string values are rejected at parse time. */
  metadata?: Record<string, string>;
  /**
   * Experimental standard field. Parsed for compatibility but never enforced;
   * the Tool Permission Runtime remains the only tool-approval authority. Its
   * presence produces one `allowed-tools-ignored` diagnostic.
   */
  allowedTools?: string[];
  /** Top-level frontmatter keys the runtime does not recognize, preserved verbatim. */
  unknownFields: string[];
}

/** Resource kind, derived from the conventional resource directory. */
export type SkillResourceKind = "reference" | "asset" | "script" | "other";

export interface SkillResource {
  /** Skill-relative POSIX path, e.g. `references/glossary.md`. */
  path: string;
  kind: SkillResourceKind;
  bytes: number;
}

/**
 * Pure parse outcome for `SKILL.md` text. The pure parser never touches the
 * filesystem, so `resources` are discovered later by the loader.
 */
export type ParseSkillResult =
  | {
      ok: true;
      metadata: SkillMetadata;
      body: string;
      bodySha256: string;
      bytes: number;
      lines: number;
      diagnostics: SkillDiagnostic[];
    }
  | { ok: false; diagnostics: SkillDiagnostic[] };

/**
 * One skill root read from disk. `rootDirectory` is internal host state for the
 * loader/store; it must not appear in catalog entries or diagnostics.
 */
export interface LoadedSkill {
  /** Directory name (the claimed Skill identity until validated). */
  name: string;
  scope: SkillScope;
  /** Absolute host path of the skill root. Internal only. */
  rootDirectory: string;
  parsed:
    | {
        ok: true;
        metadata: SkillMetadata;
        body: string;
        bodySha256: string;
        bytes: number;
        lines: number;
        resources: SkillResource[];
        diagnostics: SkillDiagnostic[];
      }
    | { ok: false; diagnostics: SkillDiagnostic[] };
}

/** Effective catalog entry: routing data only, never an absolute path. */
export interface SkillCatalogEntry {
  name: string;
  description: string;
  scope: SkillScope;
}

export interface SkillCatalog {
  entries: SkillCatalogEntry[];
  /** Deterministic SHA-256 over the effective catalog (selected winners only). */
  hash: string;
  /** Names omitted to respect the catalog budget, with the reason. */
  omitted: Array<{ name: string; scope: SkillScope; reason: string }>;
  diagnostics: SkillDiagnostic[];
}
