/**
 * Core Skills runtime: the model-visible activation surface (Phase 2).
 *
 * `src/skills/` owns the portable format, discovery, catalog hashing, and the
 * Skill Store; this module layers the session-facing runtime on top: the
 * effective per-session catalog (including `installed` Skill Store snapshots),
 * the session-frozen catalog context and its persisted snapshot, the
 * per-session activation registry, the host-side `/skill` activation path,
 * compaction reattach/loss handling, and the `activate_skill` /
 * `read_skill_resource` / `run_skill_script` tool definitions and executors.
 */

export type { SkillToolEvent } from "./types";
export {
  SKILL_ACTIVATION_KIND,
  SKILL_CATALOG_RECORD_KIND,
  SKILL_CONTEXT_LOST_KIND,
  SKILL_REATTACH_KIND,
} from "./types";

export {
  clearSessionActivations,
  getActivatedSkill,
  hydrateSessionActivations,
  isDuplicateActivation,
  pruneSessionActivations,
  recordActivation,
  removeSessionActivations,
} from "./activation-state";
export type { ActivatedSkillEntry } from "./activation-state";
export { deriveSessionActivations } from "./activation-derivation";

export { catalogNames, resolveSkillCatalog } from "./catalog";
export type { ResolvedSkillCatalog } from "./catalog";

export { computeSkillCatalogDrift, refreshSessionSkillCatalog } from "./catalog-refresh";
export type { SessionSkillCatalogRefresh, SkillCatalogDrift, SkillCatalogDriftEvent } from "./catalog-refresh";

export { resolveFilesystemSkills } from "./catalog-sources";
export type { FilesystemSkillInspection, ResolveFilesystemSkillsOptions } from "./catalog-sources";

export {
  clearSessionSkillCatalog,
  composeSkillCatalogBlock,
  eligibleCatalogHashes,
  eligibleCatalogNames,
  peekSessionSkillCatalog,
  readFrozenSessionSkillCatalog,
  resolveEngineEligibleCatalog,
  resolveSessionSkillCatalog,
} from "./catalog-context";
export {
  isMeaningfulSkillCatalogSnapshot,
  parseSkillCatalogSnapshot,
  snapshotSkillCatalog,
} from "./catalog-snapshot";
export type { SkillCatalogSnapshot, SkillCatalogSnapshotEntry } from "./catalog-snapshot";

export { activateSkillForSession } from "./host-activation";
export type { ActivateSkillForSessionOptions, HostSkillActivation, SkillActivationMode } from "./host-activation";

export { prepareSkillCompactionReattach, SKILL_REATTACH_BUDGET_BYTES } from "./compaction";
export type { SkillCompactionReattach, SkillContextLoss } from "./compaction";

export {
  createActivateSkillToolDefinition,
  executeActivateSkillTool,
  executeReadSkillResourceTool,
  executeRunSkillScriptTool,
  formatSkillActivationBlock,
  readSkillResourceToolDefinition,
  runSkillScriptToolDefinition,
} from "./tools";
export type { SkillToolRuntimeOptions, ValidSkill } from "./tools";

export { inspectSkillDraft, publishSkillDraft, SKILL_DRAFT_SCHEMA, SkillDraftError } from "./draft-publisher";
export type {
  SkillDraftErrorCode,
  SkillDraftInspection,
  SkillDraftPublication,
  SkillDraftTarget,
} from "./draft-publisher";

export { SkillMount } from "./mount";
