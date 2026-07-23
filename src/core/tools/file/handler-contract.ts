import type { FileToolEvent, ToolCall, ToolResult } from "../types";

export function parseFileToolArgs<T>(raw: string): T {
  return JSON.parse(raw || "{}") as T;
}

export function fileTextByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

export function successfulFileToolResult(
  call: ToolCall,
  content: string,
  fileEvent?: FileToolEvent,
): ToolResult {
  return { callId: call.id, name: call.name, ok: true, content, ...(fileEvent ? { fileEvent } : {}) };
}
