import { isRecord } from "./types";

type JsonRpcEnvelope = Record<string, unknown>;

/**
 * Incremental SSE envelope parser used by test fixtures and protocol
 * utilities. Production HTTP/SSE handling is owned by the SDK transport
 * in `connection.ts`.
 */
export function parseSseEnvelopes(source: string): JsonRpcEnvelope[] {
  const envelopes: JsonRpcEnvelope[] = [];
  for (const block of source.split(/\r?\n\r?\n/)) {
    const dataLines: string[] = [];
    for (const rawLine of block.split(/\r?\n/)) {
      const line = rawLine.trimEnd();
      if (!line || line.startsWith(":")) continue;
      if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).trimStart());
    }
    const data = dataLines.join("\n").trim();
    if (!data || data === "[DONE]") continue;
    const parsed = JSON.parse(data) as unknown;
    if (isRecord(parsed)) envelopes.push(parsed);
  }
  return envelopes;
}
