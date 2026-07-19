import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolveAllowedPath, toProjectPath } from "../tools/file/path-policy";
import { writableProjectRoots } from "../artifacts/roots";
import { loadEngineAssetRuntime } from "../runtime/engine-assets";
import { createSessionStore } from "../session/store";
import { requireProjectHarnessRuntime, resolveProjectHarnessRuntime } from "../harness/activation";
import { validateCharacterCard, validateScenarioCard } from "../validators";
import type { ValidationResult } from "../validators";
import type { PermissionMode } from "../permissions";
import type { ReasoningTier, VesicleMessage } from "../../providers/shared/types";
import type { StageBootstrapMetadata } from "./types";

const stageContextVersion = "stage-context/v1";

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
  messages: VesicleMessage[];
  bootstrap: StageBootstrapMetadata;
  warnings: string[];
};

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
  const characterValidation = validateCharacterCard(characterContent);
  const scenarioValidation = validateScenarioCard(scenarioContent);
  const errors = [...characterValidation.errors, ...scenarioValidation.errors];
  if (errors.length > 0) throw new Error(`Stage startup rejected:\n- ${errors.join("\n- ")}`);

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
  await session.appendMany([
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
    messages: [{ role: "assistant", content: bootstrap.renderedOpening, kind: "stage-bootstrap-opening" }],
    bootstrap,
    warnings: validationWarnings(characterValidation, scenarioValidation),
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
  const character = splitCard(characterContent, "Module A");
  const scenario = splitCard(scenarioContent, "Module B");
  const values: Record<string, string> = {
    "module_a.name": scalar(character.frontmatter, "name"),
    "module_a.archetype": scalar(character.frontmatter, "archetype"),
    "module_a.age_gender": scalar(character.frontmatter, "age_gender"),
    "module_a.inventory": scalar(character.frontmatter, "inventory"),
    "module_a.body": character.body.trim(),
    "module_b.opening_paragraph": openingParagraph(scenario.body),
    "module_b.first_line": firstLine(scenario.body),
    "module_b.scene_premise": commentSection(scenario.body, "Scene Premise"),
    "module_b.surface_emotion": commentField(scenario.body, "Surface emotion"),
    "module_b.tension_source": commentField(scenario.body, "Tension source"),
    "module_b.active_lens": commentField(scenario.body, "Active lens"),
    "module_b.identity": commentField(scenario.body, "Identity"),
    "module_b.immediate_goal": commentField(scenario.body, "Immediate goal"),
    "module_b.first_beat.label": beatField(scenario.frontmatter, "label"),
    "module_b.first_beat.tension_target": beatField(scenario.frontmatter, "tension_target"),
    "module_b.first_beat.variant_config": beatField(scenario.frontmatter, "variant_config"),
  };
  const blocks = [...template.matchAll(/```\n([\s\S]*?)\n```/g)].map((match) => match[1]!);
  if (blocks.length < 2) throw new Error("Stage context template must declare character and opening blocks.");
  return {
    characterContext: fillTemplate(blocks[0]!, values),
    opening: fillTemplate(blocks[1]!, values),
  };
}

function splitCard(content: string, label: string): { frontmatter: string; body: string } {
  const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content);
  if (!match) throw new Error(`${label} must begin with YAML frontmatter.`);
  return { frontmatter: match[1]!, body: match[2]! };
}

function scalar(frontmatter: string, key: string): string {
  const value = new RegExp(`^${key}:\\s*(.+)$`, "m").exec(frontmatter)?.[1]?.trim();
  if (!value) throw new Error(`Stage bootstrap requires Module A frontmatter field ${key}.`);
  return value.replace(/^['"]|['"]$/g, "");
}

function openingParagraph(body: string): string {
  const visible = body.split("<!--", 1)[0]!.trim();
  const quote = visible.search(/^\s*["“]/m);
  const opening = (quote < 0 ? visible : visible.slice(0, quote)).trim();
  if (!opening) throw new Error("Stage bootstrap requires a Module B opening paragraph before the first character line.");
  return opening;
}

function firstLine(body: string): string {
  const visible = body.split("<!--", 1)[0]!;
  const match = /^\s*["“]([^"”\n]+)["”]\s*$/m.exec(visible);
  if (!match) throw new Error("Stage bootstrap requires a quoted Module B first character line.");
  return match[1]!.trim();
}

function commentBlock(body: string): string {
  const match = /<!--\s*([\s\S]*?)\s*-->/.exec(body);
  if (!match) throw new Error("Stage bootstrap requires the Module B HTML-comment logic layer.");
  return match[1]!;
}

function commentSection(body: string, heading: string): string {
  const block = commentBlock(body);
  const match = new RegExp(`## ${heading}\\s*\\n([\\s\\S]*?)(?=\\n## |$)`).exec(block);
  const value = match?.[1]?.trim();
  if (!value) throw new Error(`Stage bootstrap requires Module B ${heading}.`);
  return value;
}

function commentField(body: string, label: string): string {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^-\\s*(?:\\*\\*)?${escaped}:\\s*(?:\\*\\*)?\\s*(.+)$`, "mi").exec(commentBlock(body));
  const value = match?.[1]?.trim();
  if (!value) throw new Error(`Stage bootstrap requires Module B ${label}.`);
  return value;
}

function beatField(frontmatter: string, field: string): string {
  const lines = frontmatter.split(/\r?\n/);
  const beatMapIndex = lines.findIndex((line) => /^beat_map:\s*$/.test(line));
  const firstBeatIndex = lines.findIndex((line, index) => index > beatMapIndex && /^\s*-\s*label:\s*(.+)$/.test(line));
  const firstLine = firstBeatIndex >= 0 ? lines[firstBeatIndex]! : undefined;
  const inline = field === "label" ? /^\s*-\s*label:\s*(.+)$/.exec(firstLine ?? "")?.[1] : undefined;
  const nested = firstBeatIndex >= 0
    ? lines.slice(firstBeatIndex + 1).find((line) => /^\s*-\s*label:/.test(line) || new RegExp(`^\\s+${field}:\\s*(.+)$`).test(line))
    : undefined;
  const value = inline ?? (nested && !/^\s*-\s*label:/.test(nested)
    ? new RegExp(`^\\s+${field}:\\s*(.+)$`).exec(nested)?.[1]
    : undefined);
  if (!value) throw new Error(`Stage bootstrap requires first beat ${field}.`);
  return value.trim().replace(/^['"]|['"]$/g, "");
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

function validationWarnings(...results: ValidationResult[]): string[] {
  return results.flatMap((result) => result.warnings);
}
