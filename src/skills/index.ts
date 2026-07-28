/**
 * Skills runtime public surface.
 *
 * Phase 0 delivers a strict parser/validator, bounded discovery for the
 * verified Harness and user scopes, collision and unsupported-field
 * diagnostics, an immutable versioned Skill Store with active index and safe
 * catalog hashing, and the `vesicle skills list|validate|inspect` plus
 * `vesicle doctor` integration. The model-visible activation runtime
 * (`activate_skill` / `read_skill_resource` / `run_skill_script`, the session
 * catalog, and the activation registry) is layered on top of this surface by
 * `src/core/skills/`; this module stays the format/discovery/store layer and
 * owns no session or prompt-composition behavior.
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
export { DISCOVERY_SCOPES } from "./types";

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

export { createSkill } from "./create";
export type { CreateSkillOptions, CreateSkillResult, CreateSkillScope } from "./create";

export { disabledPathForScope, projectDisabledPath, readDisabledNames, setDisabled, userDisabledPath } from "./disabled";

export { assertSafeRelativePath, classifyResource, enumerateSkillResources, isTextReference } from "./paths";

export { detectSkillRepo } from "./repo";
export type { DetectSkillRepoOptions, SkillRepoShape, SkillRepoShapeKind } from "./repo";

export {
  DISCOVERY_PRECEDENCE,
  discoverSkills,
} from "./discovery";
export type { DiscoveryResult, DiscoverSkillsOptions } from "./discovery";

export { buildCatalog } from "./catalog";
export type { BuildCatalogOptions } from "./catalog";

export {
  computeBundleHash,
  installSnapshot,
  listSkillVersions,
  readActiveIndex,
  readProvenance,
  rollbackSkill,
  setActiveVersion,
  setSkillEnabled,
  skillStoreDirectory,
  uninstallSkill,
} from "./store";
export type {
  InstallSnapshotOptions,
  SkillBundleFile,
  SkillProvenance,
  SkillSourceKind,
  SkillStoreIndex,
  SkillStoreIndexEntry,
} from "./store";
