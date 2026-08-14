// JSON entry validation for `vesicle config add-mcp --json`.
// The CLI never accepts secret values: auth produces an `${ENV}` reference and
// an empty .env slot instead, following the add-provider precedent.

import { sanitizeId, uniqueId } from "../config/yaml-writer";
import { engineIds, isEngineId, type EngineId } from "../core/engine/profile";
import { collectEnvReferences, mcpTokenEnvKey, type McpServerBlock } from "./config-edit";
import {
  protocolRevisionPattern,
  validNegotiationModes,
  type McpNegotiationMode,
} from "./types";

const entryFieldNames = [
  "name",
  "id",
  "url",
  "auth",
  "headerName",
  "enabled",
  "timeoutSeconds",
  "protocolVersion",
  "negotiation",
  "supportedProtocolVersions",
  "toolPrefix",
  "includeTools",
  "excludeTools",
  "enabledEngines",
  "headers",
] as const;

const authModes = ["none", "bearer", "custom-header"] as const;
const exactEnvReferencePattern = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;
const httpTokenPattern = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export type AddMcpServerEntry = {
  name?: string;
  id?: string;
  url: string;
  auth?: "none" | "bearer" | "custom-header";
  headerName?: string;
  enabled?: boolean;
  timeoutSeconds?: number;
  protocolVersion?: string;
  negotiation?: McpNegotiationMode;
  supportedProtocolVersions?: string[];
  toolPrefix?: string;
  includeTools?: string[];
  excludeTools?: string[];
  enabledEngines?: EngineId[];
  headers?: Record<string, string>;
};

type ParsedAddMcpServerEntry = {
  explicitId: boolean;
  baseId: string;
  url: string;
  auth: "none" | "bearer" | "custom-header";
  headerName?: string;
  enabled?: boolean;
  timeoutSeconds?: number;
  protocolVersion?: string;
  negotiation?: McpNegotiationMode;
  supportedProtocolVersions?: string[];
  toolPrefix?: string;
  includeTools?: string[];
  excludeTools?: string[];
  enabledEngines?: EngineId[];
  headers?: Record<string, string>;
};

export function parseAddMcpServerEntry(input: unknown): ParsedAddMcpServerEntry {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("MCP server entry must be a JSON object.");
  }
  const source = input as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    if (key === "secret") {
      throw new Error(
        `Field "secret" is not accepted. MCP secrets stay in .env; add-mcp creates the empty env slot for you.`,
      );
    }
    if (!(entryFieldNames as readonly string[]).includes(key)) {
      throw new Error(`Unknown MCP server entry field "${key}". Allowed: ${entryFieldNames.join(", ")}.`);
    }
  }

  const name = optionalNonEmptyString(source.name, "name");
  const explicitId = optionalNonEmptyString(source.id, "id");
  if (!name && !explicitId) {
    throw new Error(`MCP server entry requires a non-empty "name" or "id" string.`);
  }

  const baseId = explicitId
    ? explicitId
    : sanitizeId(name!);
  if (baseId !== sanitizeId(baseId)) {
    throw new Error(
      `MCP server id "${baseId}" is not canonical. Use lowercase letters, digits, "_" and "-": "${sanitizeId(baseId)}".`,
    );
  }

  const url = requireNonEmptyString(source.url, "url");
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error(`Invalid MCP URL "${url}". Must be a complete URL.`);
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error(`MCP URL must use http:// or https://, got "${parsedUrl.protocol}".`);
  }
  if (parsedUrl.username || parsedUrl.password) {
    throw new Error(`MCP URL must not contain credentials. mcp.yaml is a non-secret file.`);
  }

  const auth = readAuth(source.auth);
  const headerName = optionalNonEmptyString(source.headerName, "headerName");
  if (headerName !== undefined && !httpTokenPattern.test(headerName)) {
    throw new Error(`MCP server entry field "headerName" is not a valid HTTP header token: "${headerName}".`);
  }
  if (auth === "custom-header" && !headerName) {
    throw new Error(`MCP server entry requires "headerName" when auth is custom-header.`);
  }
  if (auth !== "custom-header" && headerName !== undefined) {
    throw new Error(`MCP server entry field "headerName" is only valid with auth: custom-header.`);
  }
  if (auth !== "none" && source.headers !== undefined) {
    throw new Error(`MCP server entry cannot combine "auth" with explicit "headers". Use one or the other.`);
  }

  const headers = readHeaders(source.headers);

  return {
    explicitId: explicitId !== undefined,
    baseId,
    url,
    auth,
    ...(headerName ? { headerName } : {}),
    ...(source.enabled !== undefined ? { enabled: readBoolean(source.enabled, "enabled") } : {}),
    ...(source.timeoutSeconds !== undefined ? { timeoutSeconds: readPositiveNumber(source.timeoutSeconds, "timeoutSeconds") } : {}),
    ...(source.protocolVersion !== undefined ? { protocolVersion: readProtocolVersion(source.protocolVersion) } : {}),
    ...(source.negotiation !== undefined ? { negotiation: readNegotiation(source.negotiation) } : {}),
    ...(source.supportedProtocolVersions !== undefined
      ? { supportedProtocolVersions: readSupportedProtocolVersions(source.supportedProtocolVersions) }
      : {}),
    ...(source.toolPrefix !== undefined ? { toolPrefix: requireNonEmptyString(source.toolPrefix, "toolPrefix") } : {}),
    ...(source.includeTools !== undefined ? { includeTools: readToolFilters(source.includeTools, "includeTools") } : {}),
    ...(source.excludeTools !== undefined ? { excludeTools: readToolFilters(source.excludeTools, "excludeTools") } : {}),
    ...(source.enabledEngines !== undefined ? { enabledEngines: readEnabledEngines(source.enabledEngines) } : {}),
    ...(headers ? { headers } : {}),
  };
}

export function materializeMcpServerBlock(
  entry: ParsedAddMcpServerEntry,
  usedIds: ReadonlySet<string>,
): { block: McpServerBlock; envKeys: string[] } {
  const id = entry.explicitId
    ? (usedIds.has(entry.baseId)
        ? throwDuplicateId(entry.baseId)
        : entry.baseId)
    : uniqueId(entry.baseId, usedIds);
  const headers: Record<string, string> = {};
  if (entry.auth === "none") {
    Object.assign(headers, entry.headers ?? {});
  } else {
    const envKey = mcpTokenEnvKey(id);
    const headerName = entry.auth === "bearer" ? "Authorization" : entry.headerName!;
    const prefix = entry.auth === "bearer" ? "Bearer " : "";
    headers[headerName] = `${prefix}\${${envKey}}`;
  }

  return {
    block: {
      id,
      enabled: entry.enabled ?? true,
      transport: "streamable-http",
      url: entry.url,
      ...(entry.timeoutSeconds !== undefined ? { timeoutSeconds: entry.timeoutSeconds } : {}),
      ...(entry.protocolVersion !== undefined ? { protocolVersion: entry.protocolVersion } : {}),
      ...(entry.toolPrefix !== undefined ? { toolPrefix: entry.toolPrefix } : {}),
      negotiation: entry.negotiation ?? "auto",
      ...(entry.supportedProtocolVersions !== undefined && entry.supportedProtocolVersions.length > 0
        ? { supportedProtocolVersions: entry.supportedProtocolVersions }
        : {}),
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      ...(entry.includeTools !== undefined && entry.includeTools.length > 0 ? { includeTools: entry.includeTools } : {}),
      ...(entry.excludeTools !== undefined && entry.excludeTools.length > 0 ? { excludeTools: entry.excludeTools } : {}),
      ...(entry.enabledEngines !== undefined && entry.enabledEngines.length > 0 ? { enabledEngines: entry.enabledEngines } : {}),
    },
    envKeys: Object.keys(headers).length > 0 ? collectEnvReferences(Object.values(headers)) : [],
  };
}

function throwDuplicateId(id: string): never {
  throw new Error(`MCP server "${id}" already exists. Remove it first or choose a different id.`);
}

function readAuth(value: unknown): "none" | "bearer" | "custom-header" {
  if (value === undefined) return "none";
  if (typeof value !== "string" || !(authModes as readonly string[]).includes(value)) {
    throw new Error(`Invalid MCP auth "${String(value)}". Allowed: ${authModes.join(", ")}.`);
  }
  return value as "none" | "bearer" | "custom-header";
}

function readHeaders(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`MCP server entry field "headers" must be an object.`);
  }
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(value as Record<string, unknown>)) {
    const headerName = name.trim();
    if (!headerName) throw new Error(`MCP header names must not be empty.`);
    if (!httpTokenPattern.test(headerName)) {
      throw new Error(`MCP header name "${headerName}" is not a valid HTTP header token.`);
    }
    if (typeof headerValue !== "string" || !headerValue.trim()) {
      throw new Error(`MCP header "${headerName}" must be a non-empty string.`);
    }
    const trimmed = headerValue.trim();
    const references = [...trimmed.matchAll(/\$\{[^}]*\}/g)].map((match) => match[0]);
    if (references.length === 0 || references.some((reference) => !exactEnvReferencePattern.test(reference))) {
      throw new Error(
        `MCP header "${headerName}" must reference environment variables using only exact "\${NAME}" syntax. `
        + `Fallback/default forms and literal secrets are not accepted through add-mcp.`,
      );
    }
    headers[headerName] = trimmed;
  }
  return headers;
}

function readBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`MCP server entry field "${field}" must be true or false.`);
  return value;
}

function readPositiveNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`MCP server entry field "${field}" must be a positive number.`);
  }
  return value;
}

function readNegotiation(value: unknown): McpNegotiationMode {
  if (typeof value !== "string" || !(validNegotiationModes as readonly string[]).includes(value)) {
    throw new Error(`MCP server entry field "negotiation" must be one of: ${validNegotiationModes.join(", ")}.`);
  }
  return value as McpNegotiationMode;
}

function readProtocolVersion(value: unknown): string {
  if (typeof value !== "string" || !protocolRevisionPattern.test(value)) {
    throw new Error(`MCP server entry field "protocolVersion" must be a YYYY-MM-DD date string.`);
  }
  return value;
}

function readSupportedProtocolVersions(value: unknown): string[] {
  const versions = readStringList(value, "supportedProtocolVersions", readProtocolVersion);
  if (versions.length === 0) {
    throw new Error(`MCP server entry field "supportedProtocolVersions" must contain at least one YYYY-MM-DD version.`);
  }
  return versions;
}

function readStringList<T extends string>(
  value: unknown,
  field: string,
  readItem: (item: unknown) => T,
): T[] {
  if (!Array.isArray(value)) throw new Error(`MCP server entry field "${field}" must be an array.`);
  const result: T[] = [];
  for (const item of value) {
    const parsed = readItem(item);
    if (!result.includes(parsed)) result.push(parsed);
  }
  return result;
}

function readToolFilters(value: unknown, field: string): string[] {
  return readStringList(value, field, (item) => {
    if (typeof item !== "string" || !item.trim()) {
      throw new Error(`MCP server entry field "${field}" entries must be non-empty strings.`);
    }
    return item.trim();
  });
}

function readEnabledEngines(value: unknown): EngineId[] {
  if (!Array.isArray(value)) throw new Error(`MCP server entry field "enabledEngines" must be an array.`);
  const result: EngineId[] = [];
  for (const raw of value) {
    if (typeof raw !== "string" || !raw.trim()) {
      throw new Error(`MCP server entry field "enabledEngines" entries must be non-empty strings.`);
    }
    const engine = raw.trim();
    if (!isEngineId(engine)) {
      throw new Error(`MCP server entry field "enabledEngines" contains unknown engine "${engine}". Allowed: ${engineIds.join(", ")}.`);
    }
    if (!result.includes(engine)) result.push(engine);
  }
  return result;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`MCP server entry requires a non-empty "${field}" string.`);
  }
  return value.trim();
}

function optionalNonEmptyString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`MCP server entry field "${field}" must be a non-empty string.`);
  }
  return value.trim();
}
