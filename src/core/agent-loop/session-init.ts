/**
 * Session identity initialization shared by the turn bootstrap and host-side
 * entry points (e.g. `/skill` as the first input of a fresh session).
 *
 * Lives in `core/agent-loop` — not `session/store` — because composing the
 * header requires config, prompt composition, assets, tool surface, and the
 * frozen Skill catalog: the same dependency set as `bootstrapTurn`. Callers
 * that must persist a complete session identity before any dependent record
 * use `initializeSessionIdentity`; `bootstrapTurn` reuses
 * `buildSessionHeaderRecord` so the two header shapes never drift.
 */

import { loadConfigForSelection } from "../../config/providers";
import type { VesicleConfig } from "../../config/env";
import type { VesicleRequest } from "../../providers/shared/types";
import { ensureProjectRoots, type RootCreationFailure } from "../project/ensure-roots";
import type { EffectiveInstructionSelection } from "../instructions";
import { composeSystemPromptWithInstructions, selectionToRecord } from "../instructions";
import { defaultPermissionRuntime, type PermissionRuntimeOptions } from "../permissions";
import { loadEngineAssetRuntime } from "../runtime/engine-assets";
import type { AssetFingerprint } from "../runtime/assets";
import { createSessionStore, type SessionRecord } from "../session/store";
import { requireProjectHarnessRuntime, resolveProjectHarnessRuntime } from "../harness/activation";
import type { HarnessRuntimeIdentity } from "../harness/driver";
import type { EngineId, EngineProfile } from "../engine/profile";
import type { ToolDefinition } from "../tools";
import {
  catalogNames,
  composeSkillCatalogBlock,
  isMeaningfulSkillCatalogSnapshot,
  resolveEngineEligibleCatalog,
  resolveSessionSkillCatalog,
  snapshotSkillCatalog,
  type SkillCatalogSnapshot,
} from "../skills";
import { generationMetadata, mergeGeneration } from "./generation";
import { resolveToolSurface, resolveWebSearchSurfaceOptions } from "./tool-surface";
import type { RunPromptOptions } from "./types";
import { appendHostContext } from "../prompt/host-context";

export type InitializeSessionIdentityOptions = Pick<
  RunPromptOptions,
  "engine" | "rootDir" | "providerSelection" | "generation" | "permission" | "harness" | "assets"
>;

export type SessionIdentity = {
  sessionId: string;
  sessionPath: string;
  /**
   * Best-effort project-root creation failures at session birth (#291);
   * empty when every root exists. Structured so the client owns rendering.
   */
  rootFailures: RootCreationFailure[];
};

export type SessionHeaderParts = {
  systemPrompt: string;
  engine: EngineId;
  config: VesicleConfig;
  permission: PermissionRuntimeOptions;
  generation: VesicleRequest["generation"] | undefined;
  profile: EngineProfile;
  toolSurface: { definitions: ToolDefinition[]; mcp: { definitions: ToolDefinition[] } };
  assets: AssetFingerprint;
  instructionalSelection: EffectiveInstructionSelection;
  harnessIdentity: HarnessRuntimeIdentity | undefined;
  skillCatalogSnapshot: SkillCatalogSnapshot | undefined;
};

export function buildSessionHeaderRecord(
  parts: SessionHeaderParts,
): Omit<SessionRecord, "uuid" | "parentUuid" | "ts" | "sessionId"> {
  const { toolSurface } = parts;
  return {
    role: "system",
    content: parts.systemPrompt,
    metadata: {
      engine: parts.engine,
      provider: parts.config.provider,
      providerId: parts.config.providerId,
      model: parts.config.model,
      permissionMode: parts.permission.mode,
      ...(parts.permission.dangerouslySkipPermissions ? { dangerouslySkipPermissions: true } : {}),
      ...generationMetadata(parts.generation),
      profile: {
        displayName: parts.profile.displayName,
        protocolVersion: parts.profile.protocolVersion,
        tools: parts.profile.defaultTools,
        effectiveModelTools: toolSurface.definitions.map((tool) => tool.function.name),
        ...(toolSurface.mcp.definitions.length > 0 ? { mcpTools: toolSurface.mcp.definitions.map((tool) => tool.function.name) } : {}),
        validators: parts.profile.validators,
        stopGates: parts.profile.stopGates,
      },
      assets: parts.assets,
      instructions: selectionToRecord(parts.instructionalSelection),
      ...(parts.harnessIdentity ? { harness: parts.harnessIdentity } : {}),
      // Bounded frozen-catalog identity (hash + name/scope/bodySha256 only);
      // omitted entirely when the session has no Skills and no diagnostics.
      ...(parts.skillCatalogSnapshot && isMeaningfulSkillCatalogSnapshot(parts.skillCatalogSnapshot)
        ? { skills: parts.skillCatalogSnapshot }
        : {}),
    },
  };
}

/**
 * Persist a complete session identity — the system header carrying engine,
 * provider/model, permission, generation, assets, instructions, Harness
 * identity, and the frozen Skill catalog — as the first durable record of a
 * brand-new session. Returns the new session's id and path.
 *
 * The header is the branch authority for everything persisted afterward, so
 * host-side callers must await this before appending any dependent record
 * (e.g. a `skill-activation`). Turn-only concerns (instruction diagnostics,
 * logical turn ids, checkpoints, instruction freezing) remain in
 * `bootstrapTurn`, which runs on the next provider turn.
 */
export async function initializeSessionIdentity(
  options: InitializeSessionIdentityOptions,
): Promise<SessionIdentity> {
  const engine = options.engine ?? "etl";
  const rootDir = options.rootDir ?? process.cwd();
  if (engine === "stage") {
    throw new Error("Stage sessions must start with /stage <character-card-path> <scenario-card-path> so bootstrap context is persisted before the first player action.");
  }
  const config = await loadConfigForSelection(options.providerSelection);
  const generation = mergeGeneration(config.generation, options.generation);
  const permission = options.permission ?? defaultPermissionRuntime;
  const projectHarness = !options.assets && !options.harness
    ? requireProjectHarnessRuntime(await resolveProjectHarnessRuntime(rootDir))
    : undefined;
  const assets = options.assets ?? projectHarness?.assets;
  const harness = options.harness ?? projectHarness?.harness;
  const engineAssets = await loadEngineAssetRuntime(engine, rootDir, assets ? { resolver: assets } : {});
  const { profile } = engineAssets;
  const instructional = await composeSystemPromptWithInstructions(engine, engineAssets.systemPrompt, rootDir);
  let systemPrompt = instructional.systemPrompt;

  // Session store first (it owns .vesicle), then the writable roots — the same
  // order as bootstrapTurn's fresh-session branch (#291).
  const session = await createSessionStore(rootDir);
  const rootFailures = await ensureProjectRoots(rootDir);

  const frozenSkillCatalog = await resolveSessionSkillCatalog(
    rootDir,
    process.env,
    profile,
    session.sessionId,
    undefined,
    config.limits?.contextWindow,
  );
  const skillCatalog = resolveEngineEligibleCatalog(frozenSkillCatalog, profile);
  const skillCatalogSnapshot = snapshotSkillCatalog(frozenSkillCatalog);
  const skillCatalogBlock = composeSkillCatalogBlock(skillCatalog.catalog);
  // Project State is a turn-start observation, not session identity. Keeping it
  // out of this pre-created header prevents the header prompt from diverging
  // from the first provider request when files change before the turn starts.
  systemPrompt = appendHostContext(systemPrompt, skillCatalogBlock);

  const toolSurface = await resolveToolSurface(
    profile,
    config.capabilities?.vision === true,
    permission.shellExecEnabled === true || permission.dangerouslySkipPermissions === true,
    permission.shellInterpreter,
    {},
    { catalogNames: catalogNames(skillCatalog) },
    await resolveWebSearchSurfaceOptions(config, session.sessionId, profile),
  );

  await session.append(
    buildSessionHeaderRecord({
      systemPrompt,
      engine,
      config,
      permission,
      generation,
      profile,
      toolSurface,
      assets: engineAssets.assets,
      instructionalSelection: instructional.selection,
      harnessIdentity: harness?.identity,
      skillCatalogSnapshot,
    }),
  );

  return { sessionId: session.sessionId, sessionPath: session.sessionPath, rootFailures };
}
