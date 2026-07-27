/**
 * Skills runtime public surface.
 *
 * Phase 0 delivers a strict parser/validator, bounded discovery for the
 * verified Harness and user scopes, collision and unsupported-field
 * diagnostics, an immutable versioned Skill Store with active index and safe
 * catalog hashing, and the `vesicle skills list|validate|inspect` plus
 * `vesicle doctor` integration. There is no model-visible activation in this
 * phase: no `activate_skill` / `read_skill_resource` tools, no `/skill`
 * command, no prompt-composition or session changes.
 *
 * See `docs/dev/SKILLS.md` for the runtime boundary and
 * `dev/docs/working/SKILLS_RUNTIME_RESEARCH_AND_FEASIBILITY.md` for the
 * research basis.
 */

export type {
  LoadedSkill,
  ParseSkillResult,
  SkillCatalog,
  SkillCatalogEntry,
  SkillDiagnostic,
  SkillDiagnosticKind,
  SkillMetadata,
  SkillResource,
  SkillResourceKind,
  SkillScope,
} from "./types";
export { PHASE0_DISCOVERY_SCOPES } from "./types";

export {
  MAX_DESCRIPTION_CHARS,
  MAX_NAME_LENGTH,
  MAX_SKILL_FILE_BYTES,
  MAX_SKILL_LINES,
  SKILL_NAME_PATTERN,
  parseSkillMarkdown,
} from "./parser";

export {
  SKILL_FILE_NAME,
  listChildSkillRoots,
  loadSkill,
  skillRootExists,
} from "./loader";

export { assertSafeRelativePath, classifyResource, enumerateSkillResources, isTextReference } from "./paths";

export {
  PHASE0_PRECEDENCE,
  discoverSkills,
} from "./discovery";
export type { DiscoveryResult, DiscoverSkillsOptions } from "./discovery";

export { buildCatalog } from "./catalog";
export type { BuildCatalogOptions } from "./catalog";

export {
  computeBundleHash,
  installSnapshot,
  readActiveIndex,
  readProvenance,
  skillStoreDirectory,
} from "./store";
export type {
  InstallSnapshotOptions,
  SkillBundleFile,
  SkillProvenance,
  SkillSourceKind,
  SkillStoreIndex,
  SkillStoreIndexEntry,
} from "./store";
