import { expect, test } from "bun:test";
import { normalizeObservation } from "../../../scripts/smoke/migration/normalize";

test("normalization preserves identity links, opaque signatures and model text", () => {
  const opaque = { payload: { uuid: "opaque-uuid", timestamp: "2026-01-01T00:00:00Z", signature: "signed-exactly" } };
  const value = { uuid: "host-a", parentUuid: "host-a", ts: "2026-01-01T00:00:00Z", content: "host-a 2026-01-01T00:00:00Z", providerState: opaque, thinkingBlocks: [{ signature: "signed-exactly", timestamp: "2026-01-01T00:00:00Z" }], toolCallId: "call-a", arguments: '{"uuid":"host-a"}' };
  expect(normalizeObservation(value)).toEqual({ ...value, uuid: "host-id-1", parentUuid: "host-id-1", ts: "<timestamp>" });
  expect(value.uuid).toBe("host-a");
  expect(normalizeObservation({ timestamp: "not-a-valid-time", role: "tool", ok: false })).toEqual({ timestamp: "not-a-valid-time", role: "tool", ok: false });
});
