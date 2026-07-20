import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolveAllowedPath, toProjectPath } from "../tools/file/path-policy";
import { listDirectoryEntries } from "../tools/file/query-operations";
import { writableProjectRoots } from "../artifacts/roots";
import { loadEngineAssetRuntime } from "../runtime/engine-assets";
import { createSessionStore } from "../session/store";
import { requireProjectHarnessRuntime, resolveProjectHarnessRuntime } from "../harness/activation";
import type { PermissionMode } from "../permissions";
import type { ReasoningTier, VesicleMessage } from "../../providers/shared/types";
import type { StageBootstrapMetadata } from "./types";

const stageContextVersion = "stage-context/v2";
const stageCompletionFileLimit = 200;

export type StartStageSessionOptions = {
  rootDir?: string;
  characterPath: string;
  scenarioPath: string;
  provider: string;
  providerId: string;
  model: string;
  permissionMode: PermissionMode;
  reasoningTier?: ReasoningTier;
};

export type StartedStageSession = {
  sessionId: string;
  sessionPath: string;
  systemPrompt: string;
  opening: string;
  openingRecordUuid: string;
  messages: VesicleMessage[];
  bootstrap: StageBootstrapMetadata;
  warnings: string[];
};

/** List guarded project-relative files eligible for Stage card selection. */
export async function listStageCardPaths(rootDir: string): Promise<string[]> {
  const paths: string[] = [];
  for (const root of writableProjectRoots) {
    if (paths.length >= stageCompletionFileLimit) break;
    const directory = await resolveAllowedPath(rootDir, root, writableProjectRoots).catch((error: unknown) => {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
      throw error;
    });
    if (!directory) continue;
    const result = await listDirectoryEntries(rootDir, directory, true).catch((error: unknown) => {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
      throw error;
    });
    if (!result) continue;
    for (const entry of result.entries) {
      if (entry.type !== "file" || entry.path.endsWith("/.gitkeep") || entry.path === ".gitkeep") continue;
      paths.push(entry.path);
      if (paths.length >= stageCompletionFileLimit) break;
    }
  }
  return paths.sort((left, right) => left.localeCompare(right));
}

/** Start a new Stage session from two guarded, immutable-at-bootstrap card inputs. */
export async function startStageSession(options: StartStageSessionOptions): Promise<StartedStageSession> {
  const rootDir = options.rootDir ?? process.cwd();
  const [characterFile, scenarioFile] = await Promise.all([
    resolveAllowedPath(rootDir, options.characterPath, writableProjectRoots),
    resolveAllowedPath(rootDir, options.scenarioPath, writableProjectRoots),
  ]);
  const [characterContent, scenarioContent] = await Promise.all([
    readFile(characterFile, "utf8"),
    readFile(scenarioFile, "utf8"),
  ]);
  const projectHarness = requireProjectHarnessRuntime(await resolveProjectHarnessRuntime(rootDir));
  const engineAssets = await loadEngineAssetRuntime("stage", rootDir, { resolver: projectHarness.assets });
  if (engineAssets.profile.defaultTools.length !== 0 || engineAssets.profile.stopGates.length !== 0) {
    throw new Error("The active Harness Stage profile must expose an empty tool surface and no stop gates.");
  }
  const template = await projectHarness.assets.readText("assets/templates/tpl_stage_context.md");
  const rendered = renderStageContext(template, characterContent, scenarioContent);
  const bootstrap: StageBootstrapMetadata = {
    schema: "prism-stage-bootstrap/v1",
    character: { path: toProjectPath(rootDir, characterFile), sha256: sha256(characterContent) },
    scenario: { path: toProjectPath(rootDir, scenarioFile), sha256: sha256(scenarioContent) },
    contextVersion: stageContextVersion,
    renderedCharacterContext: rendered.characterContext,
    renderedOpening: rendered.opening,
  };
  const session = await createSessionStore(rootDir);
  const systemPrompt = `${engineAssets.systemPrompt}\n\n${bootstrap.renderedCharacterContext}`;
  const records = await session.appendMany([
    {
      role: "system",
      content: systemPrompt,
      metadata: {
        engine: "stage",
        provider: options.provider,
        providerId: options.providerId,
        model: options.model,
        permissionMode: options.permissionMode,
        ...(options.reasoningTier ? { reasoningTier: options.reasoningTier } : {}),
        profile: {
          displayName: engineAssets.profile.displayName,
          protocolVersion: engineAssets.profile.protocolVersion,
          tools: [],
          effectiveModelTools: [],
          validators: engineAssets.profile.validators,
          stopGates: [],
        },
        assets: engineAssets.assets,
        harness: projectHarness.harness.identity,
        stageBootstrap: bootstrap,
      },
    },
    {
      role: "assistant",
      content: bootstrap.renderedOpening,
      metadata: { engine: "stage", kind: "stage-bootstrap-opening" },
    },
  ]);
  return {
    sessionId: session.sessionId,
    sessionPath: session.sessionPath,
    systemPrompt,
    opening: bootstrap.renderedOpening,
    openingRecordUuid: records[1]!.uuid,
    messages: [{ role: "assistant", content: bootstrap.renderedOpening, kind: "stage-bootstrap-opening" }],
    bootstrap,
    warnings: compatibilityWarnings(characterContent, scenarioContent, rendered.unclosedLogicMarker),
  };
}

export async function stageSourceDrift(rootDir: string, bootstrap: StageBootstrapMetadata): Promise<string[]> {
  const sources = [bootstrap.character, bootstrap.scenario];
  const drifted: string[] = [];
  for (const source of sources) {
    try {
      const path = await resolveAllowedPath(rootDir, source.path, writableProjectRoots);
      if (sha256(await readFile(path, "utf8")) !== source.sha256) drifted.push(source.path);
    } catch {
      drifted.push(source.path);
    }
  }
  return drifted;
}

function renderStageContext(template: string, characterContent: string, scenarioContent: string) {
  const scenario = splitVisibleScenario(scenarioContent);
  const values: Record<string, string> = {
    "module_a.raw": characterContent,
    "module_b.visible": scenario.visible,
    "module_b.logic": scenario.logic,
  };
  const blocks = [...template.matchAll(/```\r?\n([\s\S]*?)\r?\n```/g)].map((match) => match[1]!);
  if (blocks.length < 2) throw new Error("Stage context template must declare character and opening blocks.");
  return {
    characterContext: fillTemplate(blocks[0]!, values),
    opening: fillTemplate(blocks[1]!, values),
    unclosedLogicMarker: scenario.unclosedLogicMarker,
  };
}

function splitVisibleScenario(content: string): { visible: string; logic: string; unclosedLogicMarker: boolean } {
  const start = content.indexOf("<!--");
  if (start < 0) return { visible: content, logic: "", unclosedLogicMarker: false };
  if (content.indexOf("-->", start + 4) < 0) {
    return { visible: content, logic: "", unclosedLogicMarker: true };
  }
  return { visible: content.slice(0, start), logic: content.slice(start), unclosedLogicMarker: false };
}

function fillTemplate(template: string, values: Record<string, string>): string {
  const rendered = template.replace(/\{([^}]+)\}/g, (_match, key: string) => {
    const value = values[key];
    if (value === undefined) throw new Error(`Stage context template has no value for {${key}}.`);
    return value;
  });
  if (/\{[^}]+\}/.test(rendered)) throw new Error("Stage context template contains unresolved placeholders.");
  return rendered;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function compatibilityWarnings(characterContent: string, scenarioContent: string, unclosedLogicMarker: boolean): string[] {
  const warnings: string[] = [];
  if (characterContent.trim().length === 0 || scenarioContent.trim().length === 0) warnings.push("An empty Stage input was frozen unchanged; add narrative material before relying on continuity.");
  if (!/^\uFEFF?---\r?\n/.test(characterContent)) warnings.push("Module A has no YAML frontmatter; its supplied text was frozen unchanged.");
  if (!/^\uFEFF?---\r?\n/.test(scenarioContent)) warnings.push("Module B has no YAML frontmatter; its supplied text was frozen unchanged.");
  if (!scenarioContent.includes("<!--")) warnings.push("Module B has no optional logic content; Stage will continue from visible material.");
  if (unclosedLogicMarker) warnings.push("Module B has an unclosed HTML comment marker; it was kept in visible content unchanged.");
  return warnings.slice(0, 3);
}
