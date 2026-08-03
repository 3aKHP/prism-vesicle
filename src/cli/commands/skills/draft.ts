// skills validate/publish-draft — the structured vesicle.skill-draft/v1 JSON
// envelope commands for the skillify workflow, plus human-mode validate rendering.

import { resolve } from "node:path";
import { loadSkill } from "../../../skills";
import { inspectSkillDraft, publishSkillDraft, SKILL_DRAFT_SCHEMA } from "../../../core/skills/draft-publisher";
import { SkillDraftError } from "../../../core/skills/draft-publisher";
import type { SkillDraftTarget } from "../../../core/skills/draft-publisher";
import { printExtraMetadata, printDiagnostics } from "./inventory";

type ValidateArgs =
  | { mode: "human"; directory: string }
  | { mode: "draft"; directory: string; quietSuccess: boolean }
  | { error: string; jsonError: boolean; source?: string };

function parseValidateArgs(rest: string[]): ValidateArgs {
  let directory: string | undefined;
  let draft = false;
  let json = false;
  let quietSuccess = false;
  for (const arg of rest) {
    if (arg === "--draft") draft = true;
    else if (arg === "--json") json = true;
    else if (arg === "--quiet-success") quietSuccess = true;
    else if (!arg.startsWith("--") && directory === undefined) directory = arg;
    else return { error: `Unexpected argument: ${arg}`, jsonError: json };
  }
  if (!directory) return { error: "Usage: vesicle skills validate <skill-directory> [--draft --json [--quiet-success]]", jsonError: json };
  if (json && !draft) return { error: "--json requires --draft for draft validation.", jsonError: true };
  if (draft && !json) return { error: "--draft requires --json for structured output.", jsonError: false };
  if (quietSuccess && !(draft && json)) return { error: "--quiet-success requires --draft --json.", jsonError: draft && json };
  if (draft) return { mode: "draft", directory, quietSuccess };
  return { mode: "human", directory };
}

export async function runValidate(rest: string[]): Promise<void> {
  const parsed = parseValidateArgs(rest);
  if ("error" in parsed) {
    if (parsed.jsonError) {
      console.log(JSON.stringify(draftFailureEnvelope("validate", parsed.source ?? rest[0] ?? "", parsed.error, "invalid-arguments")));
    } else {
      console.error(parsed.error);
    }
    process.exitCode = 1;
    return;
  }
  if (parsed.mode === "draft") {
    await runValidateDraftJson(parsed.directory, parsed.quietSuccess);
    return;
  }
  await runValidateHuman(parsed.directory);
}

async function runValidateHuman(target: string): Promise<void> {
  const loaded = await loadSkill(resolve(target), "user");
  console.log("Prism Vesicle Skill Validation");
  console.log(`Path: ${target}`);
  if (loaded.parsed.ok) {
    console.log(`Name: ${loaded.parsed.metadata.name}`);
    console.log(`Description: ${loaded.parsed.metadata.description}`);
    printExtraMetadata(loaded.parsed.metadata);
    printDiagnostics(loaded.parsed.diagnostics);
    console.log(`Resources: ${loaded.parsed.resources.length}`);
    console.log("OK");
    return;
  }
  console.log(`Name: ${loaded.name}`);
  printDiagnostics(loaded.parsed.diagnostics);
  console.log("INVALID");
  process.exitCode = 1;
}

async function runValidateDraftJson(directory: string, quietSuccess: boolean): Promise<void> {
  try {
    const inspection = await inspectSkillDraft(process.cwd(), directory);
    if (quietSuccess) return;
    console.log(JSON.stringify(draftValidationEnvelope(inspection)));
  } catch (error) {
    console.log(JSON.stringify(draftFailureFromError("validate", directory, error)));
    process.exitCode = 1;
  }
}

type PublishDraftArgs =
  | { directory: string; target: SkillDraftTarget }
  | { error: string; source?: string };

function parsePublishDraftArgs(rest: string[]): PublishDraftArgs {
  let directory: string | undefined;
  let target: string | undefined;
  let json = false;
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index]!;
    if (arg === "--json") {
      if (json) return { error: "Duplicate argument: --json", source: directory };
      json = true;
    } else if (arg === "--target") {
      if (target !== undefined) return { error: "Duplicate argument: --target", source: directory };
      const value = rest[index + 1];
      if (value === undefined || value.startsWith("--")) {
        return { error: "--target requires a value.", source: directory };
      }
      target = value;
      index += 1;
    }
    else if (!arg.startsWith("--") && directory === undefined) directory = arg;
    else return { error: `Unexpected argument: ${arg}`, source: directory };
  }
  if (!directory) return { error: "Usage: vesicle skills publish-draft <draft-directory> --target project|installed --json" };
  if (!target) return { error: "Missing required --target project|installed.", source: directory };
  if (target !== "project" && target !== "installed") return { error: `--target must be "project" or "installed", got "${target}".`, source: directory };
  if (!json) return { error: "publish-draft requires --json for structured output.", source: directory };
  return { directory, target };
}

export async function runPublishDraft(rest: string[]): Promise<void> {
  const parsed = parsePublishDraftArgs(rest);
  if ("error" in parsed) {
    console.log(JSON.stringify(draftFailureEnvelope("publish", parsed.source ?? rest[0] ?? "", parsed.error, "invalid-arguments")));
    process.exitCode = 1;
    return;
  }
  try {
    const publication = await publishSkillDraft(process.cwd(), parsed.directory, parsed.target);
    console.log(JSON.stringify(draftPublicationEnvelope(publication)));
  } catch (error) {
    console.log(JSON.stringify(draftFailureFromError("publish", parsed.directory, error)));
    process.exitCode = 1;
  }
}

// --- skill-draft JSON envelope (vesicle.skill-draft/v1) ---------------------

type SkillDraftEnvelope = {
  schema: typeof SKILL_DRAFT_SCHEMA;
  operation: "validate" | "publish";
  ok: boolean;
  name?: string;
  source: string;
  target?: SkillDraftTarget;
  destination?: string;
  bundleSha256?: string;
  version?: string;
  fileCount?: number;
  diagnostics: Array<{ code: string; message: string }>;
  draftRetained: true;
  currentSessionCatalogChanged: false;
  catalogRefresh: "new-session-required";
};

function draftValidationEnvelope(inspection: Awaited<ReturnType<typeof inspectSkillDraft>>): SkillDraftEnvelope {
  return {
    schema: SKILL_DRAFT_SCHEMA,
    operation: "validate",
    ok: true,
    name: inspection.name,
    source: inspection.source,
    bundleSha256: inspection.bundleSha256,
    version: inspection.version,
    fileCount: inspection.fileCount,
    diagnostics: inspection.diagnostics,
    draftRetained: true,
    currentSessionCatalogChanged: false,
    catalogRefresh: "new-session-required",
  };
}

function draftPublicationEnvelope(publication: Awaited<ReturnType<typeof publishSkillDraft>>): SkillDraftEnvelope {
  return {
    schema: publication.schema,
    operation: "publish",
    ok: true,
    name: publication.name,
    source: publication.source,
    target: publication.target,
    destination: publication.destination,
    bundleSha256: publication.bundleSha256,
    version: publication.version,
    fileCount: publication.fileCount,
    diagnostics: [],
    draftRetained: true,
    currentSessionCatalogChanged: false,
    catalogRefresh: "new-session-required",
  };
}

function draftFailureEnvelope(
  operation: "validate" | "publish",
  source: string,
  message: string,
  code: string,
  diagnostics: Array<{ code: string; message: string }> = [],
): SkillDraftEnvelope {
  return {
    schema: SKILL_DRAFT_SCHEMA,
    operation,
    ok: false,
    source,
    diagnostics: [{ code, message }, ...diagnostics],
    draftRetained: true,
    currentSessionCatalogChanged: false,
    catalogRefresh: "new-session-required",
  };
}

function draftFailureFromError(operation: "validate" | "publish", source: string, error: unknown): SkillDraftEnvelope {
  if (error instanceof SkillDraftError) {
    return draftFailureEnvelope(operation, source, error.message, error.code, [...error.diagnostics]);
  }
  return draftFailureEnvelope(
    operation,
    source,
    operation === "validate" ? "Draft validation failed unexpectedly." : "Draft publication failed unexpectedly.",
    operation === "validate" ? "validation-failed" : "publication-failed",
  );
}
