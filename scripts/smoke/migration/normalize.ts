/** The comparison projection preserves ordering, errors, tool IDs, bytes/hashes
 * and provider-owned state. Only the explicitly enumerated host identities and
 * timestamps vary between executions. Never normalize by arbitrary regex over
 * strings: that would erase signatures, arguments or user content.
 */
const identityKeys = new Set(["uuid", "parentUuid", "sessionId", "headUuid", "recordUuid", "logicalTurnId", "providerRoundId", "messageId", "forkPointUuid", "selectedLeafUuid", "leafUuid"]);
const timeKeys = new Set(["ts", "timestamp", "createdAt", "updatedAt", "frozenAt", "capturedAt", "startedAt", "completedAt"]);
export function normalizeObservation(value: unknown): unknown {
  const identities = new Map<string, string>();
  function visit(value: unknown, key = ""): unknown {
    if (["wire", "providerState", "thinkingBlocks", "arguments", "payload", "signature"].includes(key)) return value;
    if (typeof value === "string") {
      if (identityKeys.has(key)) {
        let normalized = identities.get(value);
        if (!normalized) { normalized = `host-id-${identities.size + 1}`; identities.set(value, normalized); }
        return normalized;
      }
      if (timeKeys.has(key) && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value))) return "<timestamp>";
      return value;
    }
    if (Array.isArray(value)) return value.map((item) => visit(item));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, visit(v, k)]));
    return value;
  }
  return visit(value);
}
