import type { TavilyExtractResult, TavilyResult, WebMapArgs } from "./types";
import { truncate } from "./tavily-client";

// Internal wire-data normalization shared by the Tavily tool owners.
export function parseArgs<T>(raw: string): T {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("arguments must be a JSON object");
    }
    return parsed as T;
  } catch (error) {
    if (error instanceof Error && error.message === "arguments must be a JSON object") throw error;
    throw new Error(`Invalid tool arguments: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function mapOrCrawlRequest(args: WebMapArgs, defaults: { maxBreadth: number; limit: number }): Record<string, unknown> {
  const instructions = optionalString(args.instructions);
  const allowedDomains = normalizeRegexList(args.allowedDomains, 10);
  const allowedPaths = normalizeRegexList(args.allowedPaths, 10);
  return {
    max_depth: clampInteger(args.maxDepth, 1, 1, 3),
    max_breadth: clampInteger(args.maxBreadth, defaults.maxBreadth, 1, defaults.maxBreadth === 20 ? 50 : 30),
    limit: clampInteger(args.limit, defaults.limit, 1, defaults.limit === 20 ? 100 : 30),
    allow_external: args.allowExternal === true,
    ...(instructions ? { instructions } : {}),
    ...(allowedDomains.length > 0 ? { select_domains: allowedDomains } : {}),
    ...(allowedPaths.length > 0 ? { select_paths: allowedPaths } : {}),
    include_usage: false,
  };
}

export function normalizeNonEmptyString(value: unknown, message: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(message);
  return value.trim();
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function normalizeUrl(value: unknown, toolName: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${toolName} requires a non-empty url string.`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error(`${toolName} requires a valid URL, got "${value}".`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${toolName} supports only http:// or https:// URLs, got "${parsed.protocol}".`);
  }
  return parsed.toString();
}

export function normalizeUrls(value: unknown, toolName: string, max: number): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${toolName} requires at least one URL.`);
  }
  return value.slice(0, max).map((item) => normalizeUrl(item, toolName));
}

export function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = typeof value === "number" ? value : fallback;
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(numeric)));
}

export function enumValue<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? value as T : fallback;
}

export function optionalEnumValue<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return allowed.includes(value as T) ? value as T : undefined;
}

export function optionalDate(value: unknown, label: string): string | undefined {
  if (value == null || value === "") return undefined;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${label} must use YYYY-MM-DD format.`);
  }
  return value;
}

export function normalizeDomains(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => typeof item === "string" ? item.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "") : "")
    .filter((item) => item.length > 0)
    .slice(0, max);
}

function normalizeRegexList(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => typeof item === "string" ? item.trim() : "")
    .filter((item) => item.length > 0)
    .slice(0, max);
}

export function normalizeSearchResults(value: unknown): Array<{ title: string; url: string; snippet: string; score?: number; publishedAt?: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const result = item as TavilyResult;
    const url = typeof result.url === "string" ? result.url : "";
    if (!url) return [];
    const score = typeof result.score === "number" && Number.isFinite(result.score) ? result.score : undefined;
    const publishedAt = typeof result.published_date === "string" && result.published_date ? result.published_date : undefined;
    return [{
      title: typeof result.title === "string" && result.title ? result.title : url,
      url,
      snippet: typeof result.content === "string" ? result.content : "",
      ...(score !== undefined ? { score } : {}),
      ...(publishedAt ? { publishedAt } : {}),
    }];
  });
}

export function normalizeExtractResults(value: unknown, maxChars: number): Array<{ url: string; content: string; truncated: boolean }> {
  if (!Array.isArray(value)) return [];
  let remaining = maxChars;
  const results: Array<{ url: string; content: string; truncated: boolean }> = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || remaining <= 0) continue;
    const result = item as TavilyExtractResult;
    const url = typeof result.url === "string" ? result.url : "";
    const fullContent = typeof result.raw_content === "string" ? result.raw_content : "";
    if (!url || !fullContent) continue;
    const content = truncate(fullContent, remaining);
    results.push({ url, content, truncated: content.length < fullContent.length });
    remaining -= content.length;
  }
  return results;
}

export function normalizeUrlList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

export function normalizeCrawlResults(value: unknown, maxChars: number): Array<{ url: string; content: string; truncated: boolean }> {
  if (!Array.isArray(value)) return [];
  let remaining = maxChars;
  const results: Array<{ url: string; content: string; truncated: boolean }> = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || remaining <= 0) continue;
    const result = item as TavilyResult;
    const url = typeof result.url === "string" ? result.url : "";
    const fullContent = typeof result.raw_content === "string" ? result.raw_content : "";
    if (!url) continue;
    const content = truncate(fullContent, remaining);
    results.push({ url, content, truncated: content.length < fullContent.length });
    remaining -= content.length;
  }
  return results;
}

export function normalizeSources(value: unknown): Array<{ title: string; url: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const source = item as TavilyResult;
    const url = typeof source.url === "string" ? source.url : "";
    if (!url) return [];
    return [{ title: typeof source.title === "string" && source.title ? source.title : url, url }];
  });
}

export function normalizeFailedResults(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  return truncate(JSON.stringify(value), 500);
}

export function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}
