/**
 * Strict Agent Skills `SKILL.md` parser and validator.
 *
 * The open Agent Skills standard defines a small portable core: YAML frontmatter
 * followed by Markdown, with required `name` and `description` and optional
 * `license`, `compatibility`, string-to-string `metadata`, and the experimental
 * space-separated `allowed-tools`. This module parses exactly that core and
 * rejects anything it cannot read unambiguously, rather than splitting
 * frontmatter ad hoc. It mirrors the repository's established pattern of a
 * hand-written bounded YAML reader for each narrow schema (engine profiles,
 * Module A/B validators) so Vesicle keeps its zero-YAML-dependency runtime.
 *
 * The parser is pure: it takes already-decoded text and returns metadata plus a
 * content hash. Filesystem concerns (UTF-8 fatal decode, BOM, symlink rejection,
 * resource enumeration) live in `loader.ts`; path hardening lives in `paths.ts`.
 */

import { createHash } from "node:crypto";
import type { ParseSkillResult, SkillDiagnostic, SkillMetadata } from "./types";

/** Maximum `SKILL.md` size accepted into the inventory (research §2). */
export const MAX_SKILL_FILE_BYTES = 64 * 1024;

/** Maximum `SKILL.md` line count accepted into the inventory (research §2). */
export const MAX_SKILL_LINES = 500;

/** Standard maximum `description` length in code points. */
export const MAX_DESCRIPTION_CHARS = 1024;

/** Standard maximum `name` length. */
export const MAX_NAME_LENGTH = 64;

/**
 * Skill `name` grammar: segments of lowercase alphanumeric characters joined
 * by single hyphens. Rejects leading, trailing, and repeated hyphens.
 */
export const SKILL_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const FRONTMATTER_FENCE = /^---\s*$/;
const FULL_LINE_COMMENT = /^\s*#/;

/** Frontmatter keys the runtime recognizes. Anything else is `unsupported-field`. */
const KNOWN_FRONTMATTER_KEYS = new Set(["name", "description", "license", "compatibility", "metadata", "allowed-tools"]);

class FrontmatterError extends Error {}

/**
 * Parse and validate `SKILL.md` text.
 *
 * `expectedName` is the parent directory name; a `name` that does not match it
 * is a hard validation failure, since the standard requires the directory and
 * the declared name to agree.
 */
export function parseSkillMarkdown(content: string, expectedName?: string): ParseSkillResult {
  const diagnostics: SkillDiagnostic[] = [];

  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_SKILL_FILE_BYTES) {
    diagnostics.push({
      kind: "oversized-skill",
      message: `SKILL.md is ${bytes} bytes; the limit is ${MAX_SKILL_FILE_BYTES}.`,
    });
    return { ok: false, diagnostics };
  }

  const lines = content.split(/\r?\n/);
  if (lines.length > MAX_SKILL_LINES) {
    diagnostics.push({
      kind: "oversized-skill",
      message: `SKILL.md has ${lines.length} lines; the limit is ${MAX_SKILL_LINES}.`,
    });
    return { ok: false, diagnostics };
  }

  const split = splitFrontmatter(lines);
  if (!split.ok) return { ok: false, diagnostics: [...diagnostics, split.diagnostic] };

  let fields: ParsedFields;
  try {
    fields = parseFrontmatterYaml(split.frontmatterLines);
  } catch (error) {
    if (error instanceof FrontmatterError) {
      return { ok: false, diagnostics: [...diagnostics, { kind: "parse-error", message: error.message }] };
    }
    throw error;
  }

  for (const key of fields.unknownKeys) {
    diagnostics.push({ kind: "unsupported-field", message: `Unsupported frontmatter field "${key}" is preserved but ignored.` });
  }

  const name = readString(fields, "name");
  const description = readString(fields, "description");

  const nameDiagnostic = validateName(name, expectedName);
  if (nameDiagnostic) return { ok: false, diagnostics: [...diagnostics, nameDiagnostic] };

  const descriptionDiagnostic = validateDescription(description);
  if (descriptionDiagnostic) return { ok: false, diagnostics: [...diagnostics, descriptionDiagnostic] };

  // validateName/validateDescription returned no diagnostic, so both are valid
  // non-empty strings. The narrowing check also serves as a defensive guard.
  if (name === undefined || description === undefined) {
    return { ok: false, diagnostics: [...diagnostics, { kind: "parse-error", message: "Validated name or description is unexpectedly absent." }] };
  }
  const validName = name;
  const validDescription = description;

  const allowedToolsRaw = fields.scalars.has("allowed-tools") ? fields.scalars.get("allowed-tools") : undefined;
  let allowedTools: string[] | undefined;
  if (allowedToolsRaw !== undefined) {
    allowedTools = allowedToolsRaw.split(/\s+/).filter((token) => token.length > 0);
    diagnostics.push({
      kind: "allowed-tools-ignored",
      message: "allowed-tools is parsed for compatibility but ignored; the Tool Permission Runtime remains authoritative.",
    });
  }

  const body = split.body;
  const metadata: SkillMetadata = {
    name: validName,
    description: validDescription,
    unknownFields: [...fields.unknownKeys].sort(),
  };
  const license = readOptionalString(fields, "license");
  if (license !== undefined) metadata.license = license;
  const compatibility = readOptionalString(fields, "compatibility");
  if (compatibility !== undefined) metadata.compatibility = compatibility;
  if (fields.metadata) metadata.metadata = fields.metadata;
  if (allowedTools) metadata.allowedTools = allowedTools;

  return {
    ok: true,
    metadata,
    body,
    bodySha256: sha256(body),
    bytes,
    lines: lines.length,
    diagnostics,
  };
}

// --- frontmatter splitting --------------------------------------------------

function splitFrontmatter(lines: string[]): { ok: true; frontmatterLines: string[]; body: string } | { ok: false; diagnostic: SkillDiagnostic } {
  if (lines.length === 0 || !FRONTMATTER_FENCE.test(lines[0]!)) {
    return { ok: false, diagnostic: { kind: "missing-frontmatter", message: "SKILL.md must start with a --- frontmatter fence." } };
  }
  let closeIndex = -1;
  for (let index = 1; index < lines.length; index++) {
    if (FRONTMATTER_FENCE.test(lines[index]!)) {
      closeIndex = index;
      break;
    }
  }
  if (closeIndex === -1) {
    return { ok: false, diagnostic: { kind: "missing-closing-fence", message: "SKILL.md frontmatter is missing its closing --- fence." } };
  }
  const frontmatterLines = lines.slice(1, closeIndex);
  const body = lines.slice(closeIndex + 1).join("\n");
  return { ok: true, frontmatterLines, body };
}

// --- bounded frontmatter YAML reader ---------------------------------------

type ParsedFields = {
  /** Top-level scalar values, keyed by frontmatter key. */
  scalars: Map<string, string>;
  /** `metadata` nested string-to-string map, if declared. */
  metadata?: Record<string, string>;
  /** Top-level keys that are not in the recognized set. */
  unknownKeys: string[];
};

function parseFrontmatterYaml(fmLines: string[]): ParsedFields {
  const scalars = new Map<string, string>();
  let metadata: Record<string, string> | undefined;
  const unknownKeys: string[] = [];
  let metadataOpen = false;

  for (let index = 0; index < fmLines.length; index++) {
    const rawLine = fmLines[index]!;
    if (rawLine.trim() === "" || FULL_LINE_COMMENT.test(rawLine)) continue;

    const indentMatch = /^([ \t]+)/.exec(rawLine);
    if (indentMatch) {
      if (indentMatch[1].includes("\t")) {
        throw new FrontmatterError(`Frontmatter line ${index + 1}: tabs are not valid indentation; use spaces.`);
      }
      if (indentMatch[1].length !== 2 || !metadataOpen) {
        throw new FrontmatterError(`Frontmatter line ${index + 1}: unexpected indentation.`);
      }
      const entry = parseMapEntry(rawLine.slice(2), index);
      metadata ??= {};
      if (Object.hasOwn(metadata, entry.key)) {
        throw new FrontmatterError(`Frontmatter line ${index + 1}: duplicate metadata key "${entry.key}".`);
      }
      metadata[entry.key] = entry.value;
      continue;
    }

    metadataOpen = false;
    const colon = rawLine.indexOf(":");
    if (colon === -1) {
      throw new FrontmatterError(`Frontmatter line ${index + 1}: missing key colon in "${rawLine}".`);
    }
    const key = rawLine.slice(0, colon).trim();
    if (key.length === 0) {
      throw new FrontmatterError(`Frontmatter line ${index + 1}: empty key.`);
    }
    if (scalars.has(key)) {
      throw new FrontmatterError(`Frontmatter line ${index + 1}: duplicate key "${key}".`);
    }
    const rawValue = rawLine.slice(colon + 1);

    if (rawValue.trim() === "") {
      if (key === "metadata") {
        metadataOpen = true;
        scalars.set(key, "");
        continue;
      }
      scalars.set(key, "");
      if (!KNOWN_FRONTMATTER_KEYS.has(key)) unknownKeys.push(key);
      continue;
    }

    const scalar = extractScalarValue(rawValue, index);
    scalars.set(key, scalar);
    if (!KNOWN_FRONTMATTER_KEYS.has(key)) unknownKeys.push(key);
  }

  return { scalars, ...(metadata ? { metadata } : {}), unknownKeys };
}

function parseMapEntry(rawLine: string, lineIndex: number): { key: string; value: string } {
  const colon = rawLine.indexOf(":");
  if (colon === -1) {
    throw new FrontmatterError(`Frontmatter line ${lineIndex + 1}: metadata entry missing key colon.`);
  }
  const key = rawLine.slice(0, colon).trim();
  if (key.length === 0) {
    throw new FrontmatterError(`Frontmatter line ${lineIndex + 1}: empty metadata key.`);
  }
  const rawValue = rawLine.slice(colon + 1);
  if (rawValue.trim() === "") return { key, value: "" };
  return { key, value: extractScalarValue(rawValue, lineIndex) };
}

/**
 * Extract one scalar value (plain, double-quoted, or single-quoted) from the
 * text following a `key:`. Quoted forms allow values to contain `: ` or `#`;
 * plain forms reject those ambiguous shapes so the value is never mis-split.
 */
function extractScalarValue(rawValue: string, lineIndex: number): string {
  const trimmed = rawValue.trim();
  const first = trimmed[0];
  if (first === '"') return parseDoubleQuoted(trimmed, lineIndex);
  if (first === "'") return parseSingleQuoted(trimmed, lineIndex);
  return parsePlainScalar(trimmed, lineIndex);
}

function parseDoubleQuoted(trimmed: string, lineIndex: number): string {
  if (trimmed.length < 2 || !trimmed.endsWith('"')) {
    throw new FrontmatterError(`Frontmatter line ${lineIndex + 1}: double-quoted value is not closed on one line.`);
  }
  const inner = trimmed.slice(1, -1);
  let result = "";
  for (let index = 0; index < inner.length; index++) {
    const ch = inner[index]!;
    if (ch === "\\") {
      const next = inner[index + 1];
      if (next === undefined) throw new FrontmatterError(`Frontmatter line ${lineIndex + 1}: trailing backslash in double-quoted value.`);
      const mapped = escapeChar(next);
      result += mapped ?? next;
      index += 1;
    } else {
      result += ch;
    }
  }
  return result;
}

function escapeChar(ch: string): string | undefined {
  switch (ch) {
    case "n": return "\n";
    case "r": return "\r";
    case "t": return "\t";
    case "b": return "\b";
    case "f": return "\f";
    case "0": return "\0";
    case '"': return '"';
    case "\\": return "\\";
    case "/": return "/";
    default: return undefined;
  }
}

function parseSingleQuoted(trimmed: string, lineIndex: number): string {
  if (trimmed.length < 2 || !trimmed.endsWith("'")) {
    throw new FrontmatterError(`Frontmatter line ${lineIndex + 1}: single-quoted value is not closed on one line.`);
  }
  return trimmed.slice(1, -1).replaceAll("''", "'");
}

/** Plain-scalar prefixes that always indicate a YAML structure (`[1,2]`, `&anchor`, …). */
const PLAIN_PREFIX_ALWAYS = ["[", "]", "{", "}", "&", "*", "!", "|", ">", "%", "@", "`", "#"];
/** Prefixes that indicate structure only when followed by a space (`- item`, `? key`, `: value`). */
const PLAIN_PREFIX_IF_SPACE = ["-", "?", ":"];

function parsePlainScalar(trimmed: string, lineIndex: number): string {
  for (const indicator of PLAIN_PREFIX_ALWAYS) {
    if (trimmed.startsWith(indicator)) {
      throw new FrontmatterError(`Frontmatter line ${lineIndex + 1}: a value starting with "${indicator}" must be quoted.`);
    }
  }
  for (const indicator of PLAIN_PREFIX_IF_SPACE) {
    if (trimmed.startsWith(indicator) && (trimmed.length === 1 || trimmed[1] === " ")) {
      throw new FrontmatterError(`Frontmatter line ${lineIndex + 1}: a value starting with "${indicator} " must be quoted.`);
    }
  }
  if (trimmed.includes(": ") || trimmed.endsWith(":")) {
    throw new FrontmatterError(`Frontmatter line ${lineIndex + 1}: value contains ": "; use quotes to include a colon.`);
  }
  if (trimmed.includes(" #")) {
    throw new FrontmatterError(`Frontmatter line ${lineIndex + 1}: value contains " #"; use quotes or remove the comment.`);
  }
  return trimmed;
}

// --- field readers and validators ------------------------------------------

function readString(fields: ParsedFields, key: string): string | undefined {
  return fields.scalars.has(key) ? fields.scalars.get(key) : undefined;
}

function readOptionalString(fields: ParsedFields, key: string): string | undefined {
  if (!fields.scalars.has(key)) return undefined;
  const value = fields.scalars.get(key);
  return value && value.length > 0 ? value : undefined;
}

function validateName(name: string | undefined, expectedName: string | undefined): SkillDiagnostic | undefined {
  if (name === undefined || name.length === 0) {
    return { kind: "name-missing", message: "SKILL.md frontmatter is missing a non-empty name." };
  }
  if (name.length > MAX_NAME_LENGTH || !SKILL_NAME_PATTERN.test(name)) {
    return {
      kind: "name-invalid",
      message: `Skill name "${name}" must be 1-${MAX_NAME_LENGTH} lowercase alphanumeric segments joined by single hyphens.`,
    };
  }
  if (expectedName !== undefined && name !== expectedName) {
    return {
      kind: "name-directory-mismatch",
      message: `Skill name "${name}" does not match its directory name "${expectedName}".`,
    };
  }
  return undefined;
}

function validateDescription(description: string | undefined): SkillDiagnostic | undefined {
  if (description === undefined) {
    return { kind: "description-missing", message: "SKILL.md frontmatter is missing a description." };
  }
  if (description.trim().length === 0) {
    return { kind: "description-empty", message: "Skill description must not be empty." };
  }
  const chars = [...description].length;
  if (chars > MAX_DESCRIPTION_CHARS) {
    return {
      kind: "description-oversized",
      message: `Skill description is ${chars} characters; the limit is ${MAX_DESCRIPTION_CHARS}.`,
    };
  }
  return undefined;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
