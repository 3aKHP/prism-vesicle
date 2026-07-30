import { describe, expect, test } from "bun:test";
import ledger from "../../fixtures/openai-responses/compatibility-ledger-v1.json";
import lifecycle from "../../fixtures/openai-responses/lifecycle-v1.json";
import profile from "../../fixtures/openai-responses/profile-v1.json";
import captures from "../../fixtures/openai-responses/request-captures-v1.json";
import { compareStructuredCapture, type JsonValue } from "../../support/providers/responses-conformance";

const privateNames = /^(?:x-codex-|session_id$|thread_id$|turn_id$|attestation$)/i;
const secretMaterial = /(?:bearer\s+|sk-[a-z0-9]|api[_-]?key\s*[=:])/i;

describe("OpenAI Responses conformance evidence", () => {
  test("pins reviewable sources and an application-layer claim", () => {
    expect(profile.evidence.codex.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(profile.evidence.codex.sources.every((source) => /^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(source.lines))).toBe(true);
    expect(profile.evidence.publicDocs.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(profile.claim.layer).toBe("application");
    expect(profile.claim.excluded).toEqual(expect.arrayContaining([
      "TLS ClientHello and ALPN",
      "HTTP/2 framing and HPACK",
      "Codex private product identity and attestation",
    ]));
  });

  test("classifies every captured application-controlled field", () => {
    const classified = new Set(captures.fieldClassifications.map((field) => `${field.scope}:${field.name}`));
    const missing: string[] = [];
    for (const capture of captures.captures) {
      for (const header of Object.keys(capture.headers)) {
        if (!classified.has(`header:${header}`)) missing.push(`${capture.id}:header:${header}`);
      }
      for (const field of capture.orderedBodyKeys) {
        if (!classified.has(`body:${field}`)) missing.push(`${capture.id}:body:${field}`);
      }
      expect(Object.keys(capture.body)).toEqual(capture.orderedBodyKeys);
    }
    expect(missing).toEqual([]);
    expect(new Set(captures.fieldClassifications.map((field) => field.class))).toEqual(new Set([
      "public-required",
      "public-optional-profiled",
      "transport-derived",
      "dynamic",
      "private-identity",
    ]));
  });

  test("contains no secret or Codex-private capture values", () => {
    const serialized = JSON.stringify(captures.captures);
    expect(serialized).not.toMatch(secretMaterial);
    for (const capture of captures.captures) {
      expect(Object.keys(capture.headers).filter((name) => privateNames.test(name))).toEqual([]);
      expect(findPrivateKeys(asJsonValue(capture.body))).toEqual([]);
    }
  });

  test("makes public and Codex-beta WebSocket differences explicit", () => {
    const codex = capture("codex-beta-ws-generate");
    const publicWs = capture("openai-public-ws-generate");
    const allowed = new Set([
      "$.headers.openai-beta",
      "$.body.stream",
      "$.body.stream_options",
      "$.orderedBodyKeys",
      "$.id",
      "$.profile",
    ]);
    expect(compareStructuredCapture(asJsonValue(codex), asJsonValue(publicWs), allowed)).toEqual([]);
  });

  test("defines a capability-constrained MiMo counterexample", () => {
    const mimo = profile.profiles.mimoSubset20260729;
    expect(mimo.tier).toBe("responses-compatible-subset");
    expect(mimo.previousResponseId).toBe(false);
    expect(mimo.remoteCompact).toBe(false);
    expect(mimo.websocket).toBe(false);
    expect(mimo.supportedEventFamilies).toContain("response.reasoning_text.*");
    for (const unsupported of mimo.unsupportedRequestFields) {
      expect(mimo.supportedRequestFields).not.toContain(unsupported);
    }
  });

  test("records retry, terminal commit, and compatibility decisions", () => {
    expect(lifecycle.retry).toMatchObject({
      maxRetriesBeforeWebSocketDowngrade: 5,
      counterMeaning: "retries after the triggering attempt",
      attemptAccumulatorsAreIsolated: true,
      fallbackTransport: "http",
      cancellationRetries: false,
    });
    expect(lifecycle.commitBarrier).toEqual({
      pendingEvent: "response.output_item.done",
      commitEvent: "response.completed",
      toolDispatchBeforeCommit: false,
      failedAttemptDurableOutput: false,
      retrySideEffectCount: 1,
    });
    expect(new Set(ledger.entries.map((entry) => entry.id))).toEqual(new Set([
      "ws-stream-field",
      "encrypted-reasoning-include",
      "websocket-owner",
      "private-identity",
      "mimo-subset",
      "network-fingerprint",
    ]));
    expect(ledger.entries.every((entry) => entry.codex && entry.public && entry.selected && entry.test)).toBe(true);
  });
});

function capture(id: string) {
  const result = captures.captures.find((candidate) => candidate.id === id);
  if (!result) throw new Error(`Missing fixture capture ${id}.`);
  return result;
}

function findPrivateKeys(value: JsonValue, path = "$"): string[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => findPrivateKeys(item, `${path}[${index}]`));
  if (!value || typeof value !== "object") return [];
  const matches: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    if (privateNames.test(key)) matches.push(`${path}.${key}`);
    matches.push(...findPrivateKeys(child, `${path}.${key}`));
  }
  return matches;
}

function asJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
