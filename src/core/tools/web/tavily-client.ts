import { loadUserConfigEnvironment } from "../../../config/providers";
import type { ToolCall, ToolResult } from "../types";

export async function loadTavilyApiKey(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const loaded = await loadUserConfigEnvironment(env);
  return loaded.effectiveEnv.TAVILY_API_KEY;
}

export function tavilyHeaders(apiKey: string): Record<string, string> {
  return {
    "Authorization": `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

export function tavilyMissing(call: ToolCall, label: string): ToolResult {
  return fail(call, `Tavily web ${label} is not configured. Set TAVILY_API_KEY in the user-level prism-vesicle .env file or process environment.`);
}

export async function tavilyError(label: string, response: Response): Promise<string> {
  const body = await response.text().catch(() => "");
  return `Tavily ${label} failed (${response.status} ${response.statusText})${body ? `: ${truncate(body, 500)}` : "."}`;
}

export function fail(call: ToolCall, content: string): ToolResult {
  return { callId: call.id, name: call.name, ok: false, content };
}

export function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
