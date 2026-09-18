import { createHash } from "node:crypto";

export function responsesEndpointFingerprint(baseUrl: string): string {
  const normalized = new URL(baseUrl).toString().replace(/\/$/, "");
  return `sha256:${createHash("sha256").update(normalized).digest("hex")}`;
}

/**
 * Canonical owner key for per-owner module state (WebSocket session registry,
 * negotiated compaction variant). The separator, part order, and profile field
 * must have exactly this one owner.
 */
export function responsesOwnerKey(providerId: string, model: string, endpointFingerprint: string, profile: string): string {
  return [providerId, model, endpointFingerprint, profile].join("\u0000");
}
