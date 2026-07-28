/**
 * Structured events emitted by the model-visible Skill tools.
 *
 * Every payload carries logical Skill identity (name, scope, content hash,
 * skill-relative paths) and never an absolute host path, so session records,
 * resume projection, and TUI rendering can rely on them verbatim. The
 * `skill_script_exec` payload is provenance only; execution outcome rides in
 * the reused `ProcessToolEvent` on the same tool result.
 */

import type { SkillDiagnostic, SkillResource, SkillScope } from "../../skills/types";

/**
 * Session-record `metadata.kind` values owned by the Skills runtime.
 * `skill-activation` marks the host-injected user record carrying an activated
 * body (host `/skill` path); `skill-activation-reattach` marks the user message
 * inside a compact checkpoint that preserves an active body; `skill-catalog`
 * marks the system record persisting the frozen catalog snapshot;
 * `skill-context-lost` marks the system notice that compaction dropped an
 * active Skill and it must be reactivated.
 */
export const SKILL_ACTIVATION_KIND = "skill-activation";
export const SKILL_REATTACH_KIND = "skill-activation-reattach";
export const SKILL_CATALOG_RECORD_KIND = "skill-catalog";
export const SKILL_CONTEXT_LOST_KIND = "skill-context-lost";

export type SkillToolEvent =
  | {
    kind: "skill_activation";
    name: string;
    scope: SkillScope;
    /** SHA-256 of the activated `SKILL.md` body (without frontmatter). */
    contentHash: string;
    /** True when the same name+hash was already active; the body was not re-injected. */
    alreadyActive: boolean;
    resources: SkillResource[];
    diagnostics: SkillDiagnostic[];
  }
  | {
    kind: "skill_resource_read";
    name: string;
    /** Skill-relative POSIX path that was read. */
    path: string;
    /** Size of the on-disk file in bytes (before the 256 KiB read cap). */
    bytes: number;
    /** True when the content was capped at the 256 KiB text limit. */
    truncated: boolean;
  }
  | {
    kind: "skill_script_exec";
    name: string;
    /** SHA-256 of the active Skill body the script belongs to. */
    contentHash: string;
    /** Skill-relative POSIX path of the executed script. */
    path: string;
    interpreter: string;
    args: string[];
  };
