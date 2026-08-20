// Line-preserving edits for the constrained providers.yaml shape.

import { stripYamlComment } from "./yaml-line-reader";
import { yamlKey, yamlScalar } from "./yaml-writer";
import { serializeProviderModelLines, type ProviderModelProfile, type ProviderProfile } from "./providers";

type RawLine = { raw: string; indent: number; text: string; semantic: boolean };

export function appendModelToProviderSource(source: string, providerId: string, model: ProviderModelProfile): string {
  const lines = readLines(source);
  const provider = findProvider(lines, providerId);
  const models = findModels(lines, provider.start, provider.end);
  const insertion = trimTrailingBlanks(lines, models.end);
  lines.splice(insertion, 0, ...serializeProviderModelLines(model).map(rawLine));
  return writeLines(lines);
}

export function appendProviderToSource(source: string, provider: ProviderProfile): string {
  const lines = readLines(source);
  const section = findProvidersSection(lines);
  const insertion = trimTrailingBlanks(lines, section.end);
  lines.splice(insertion, 0, ...serializeProviderLines(provider));
  return writeLines(lines);
}

export function replaceProviderFieldInSource(
  source: string,
  providerId: string,
  field: string,
  value: string,
): string {
  const lines = readLines(source);
  const provider = findProvider(lines, providerId);
  const existing = findField(lines, provider.start, provider.end, 4, field);
  if (existing !== undefined) {
    lines[existing] = { ...lines[existing]!, raw: replaceValue(lines[existing]!.raw, value) };
    return writeLines(lines);
  }
  const models = findModels(lines, provider.start, provider.end);
  lines.splice(models.start, 0, rawLine(`    ${yamlKey(field)}: ${value}`));
  return writeLines(lines);
}

export function replaceDefaultSelectionInSource(source: string, field: "provider" | "model", value: string): string {
  const lines = readLines(source);
  const section = lines.findIndex((line) => line.semantic && line.indent === 0 && line.text === "default:");
  if (section === -1) throw new Error('Provider config is missing the "default:" section.');
  const end = nextSemanticAtOrBelow(lines, section + 1, 0);
  const row = findField(lines, section, end, 2, field);
  if (row === undefined) throw new Error(`Provider config is missing default field "${field}".`);
  lines[row] = { ...lines[row]!, raw: replaceValue(lines[row]!.raw, value) };
  return writeLines(lines);
}

export function removeModelFromSource(source: string, providerId: string, modelId: string): string {
  const lines = readLines(source);
  const provider = findProvider(lines, providerId);
  const models = findModels(lines, provider.start, provider.end);
  const model = findModel(lines, models.start, models.end, modelId);
  const end = nextSemanticAtOrBelow(lines, model + 1, 6, models.end);
  const retained = lines.slice(model, end).filter((line, index) => {
    if (index === 0 || line.semantic) return false;
    return line.indent < 8;
  });
  lines.splice(model, end - model, ...retained);
  return writeLines(lines);
}

export function removeProviderFromSource(source: string, providerId: string): string {
  const hadFinalNewline = source.replace(/\r\n/g, "\n").endsWith("\n");
  const lines = readLines(source);
  const provider = findProvider(lines, providerId);
  const retained = lines.slice(provider.start, provider.end).filter((line) => {
    if (line.semantic) return false;
    return line.indent < 4;
  });
  lines.splice(provider.start, provider.end - provider.start, ...retained);
  if (hadFinalNewline && lines[lines.length - 1]?.raw !== "") lines.push(rawLine(""));
  return writeLines(lines);
}

function findProvidersSection(lines: RawLine[]): { start: number; end: number } {
  const start = lines.findIndex((line) => line.semantic && line.indent === 0 && line.text === "providers:");
  if (start === -1) throw new Error('Provider config is missing the "providers:" section.');
  return { start, end: nextSemanticAtOrBelow(lines, start + 1, 0) };
}

function findProvider(lines: RawLine[], providerId: string): { start: number; end: number } {
  const section = findProvidersSection(lines);
  const start = lines.findIndex((line, index) => (
    index > section.start
    && index < section.end
    && line.semantic
    && line.indent === 2
    && line.text === `${providerId}:`
  ));
  if (start === -1) throw new Error(`Provider "${providerId}" was not found in providers.yaml.`);
  return { start, end: nextSemanticAtOrBelow(lines, start + 1, 2, section.end) };
}

function findModels(lines: RawLine[], providerStart: number, providerEnd: number): { start: number; end: number } {
  const start = lines.findIndex((line, index) => (
    index > providerStart
    && index < providerEnd
    && line.semantic
    && line.indent === 4
    && line.text === "models:"
  ));
  if (start === -1) throw new Error("Provider is missing a models: list.");
  return { start, end: nextSemanticAtOrBelow(lines, start + 1, 4, providerEnd) };
}

function findModel(lines: RawLine[], modelsStart: number, modelsEnd: number, modelId: string): number {
  for (let index = modelsStart + 1; index < modelsEnd; index++) {
    const line = lines[index]!;
    if (!line.semantic || line.indent !== 6 || !line.text.startsWith("- ")) continue;
    const entry = line.text.slice(2).trim();
    const id = entry.startsWith("id:") ? entry.slice(3).trim() : entry;
    if (unquote(id) === modelId) return index;
  }
  throw new Error(`Model "${modelId}" was not found in providers.yaml.`);
}

function findField(lines: RawLine[], start: number, end: number, indent: number, field: string): number | undefined {
  const prefix = `${field}:`;
  for (let index = start + 1; index < end; index++) {
    const line = lines[index]!;
    if (line.semantic && line.indent === indent && line.text.startsWith(prefix)) return index;
  }
  return undefined;
}

function nextSemanticAtOrBelow(lines: RawLine[], start: number, indent: number, limit = lines.length): number {
  for (let index = start; index < limit; index++) {
    const line = lines[index]!;
    if (line.semantic && line.indent <= indent) return index;
  }
  return limit;
}

function trimTrailingBlanks(lines: RawLine[], end: number): number {
  let insertion = end;
  while (insertion > 0 && lines[insertion - 1]!.raw.trim() === "") insertion--;
  return insertion;
}

function serializeProviderLines(provider: ProviderProfile): RawLine[] {
  const lines = [
    `  ${yamlKey(provider.id)}:`,
    `    protocol: ${provider.protocol}`,
    `    baseUrl: ${yamlScalar(provider.baseUrl)}`,
    `    apiKeyEnv: ${provider.apiKeyEnv}`,
  ];
  if (provider.authMethod) lines.push(`    authMethod: ${provider.authMethod}`);
  if (provider.userAgent) lines.push(`    userAgent: ${yamlScalar(provider.userAgent)}`);
  if (provider.responsesProfile) lines.push(`    responsesProfile: ${provider.responsesProfile}`);
  if (provider.responsesTransport) lines.push(`    responsesTransport: ${provider.responsesTransport}`);
  if (provider.defaultModel) lines.push(`    defaultModel: ${yamlScalar(provider.defaultModel)}`);
  lines.push("    models:");
  for (const model of provider.models) lines.push(...serializeProviderModelLines(model));
  return lines.map(rawLine);
}

function replaceValue(line: string, value: string): string {
  const withoutComment = stripYamlComment(line);
  const colon = withoutComment.indexOf(":");
  if (colon === -1) throw new Error(`Invalid provider field line "${line}".`);
  const valueArea = withoutComment.slice(colon + 1);
  const leadingWhitespace = valueArea.match(/^\s*/)?.[0] ?? "";
  const trailingWhitespace = valueArea.match(/\s*$/)?.[0] ?? "";
  const comment = line.slice(withoutComment.length);
  return `${withoutComment.slice(0, colon + 1)}${leadingWhitespace}${value}${trailingWhitespace}${comment}`;
}

function readLines(source: string): RawLine[] {
  return source.replace(/\r\n/g, "\n").split("\n").map((raw) => {
    const withoutComment = stripYamlComment(raw).replace(/\s+$/, "");
    const match = raw.match(/^ */);
    const indent = match?.[0].length ?? 0;
    return { raw, indent, text: withoutComment.trim(), semantic: Boolean(withoutComment.trim()) };
  });
}

function writeLines(lines: RawLine[]): string {
  return `${lines.map((line) => line.raw).join("\n")}`;
}

function rawLine(raw: string): RawLine {
  const withoutComment = stripYamlComment(raw).replace(/\s+$/, "");
  const match = raw.match(/^ */);
  return { raw, indent: match?.[0].length ?? 0, text: withoutComment.trim(), semantic: Boolean(withoutComment.trim()) };
}

function unquote(value: string): string {
  if (value.startsWith("\"") && value.endsWith("\"")) {
    try { return JSON.parse(value) as string; } catch { return value.slice(1, -1); }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  return value;
}
