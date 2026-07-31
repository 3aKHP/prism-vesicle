import { describe, expect, test } from "bun:test";
import sourceEvidence from "../../fixtures/openai-responses/codex-source-evidence-v1.json";
import ledger from "../../fixtures/openai-responses/compatibility-ledger-v1.json";
import events from "../../fixtures/openai-responses/event-captures-v1.json";
import lifecycle from "../../fixtures/openai-responses/lifecycle-v1.json";
import profile from "../../fixtures/openai-responses/profile-v1.json";
import captures from "../../fixtures/openai-responses/request-captures-v1.json";
import { compareStructuredCapture, type JsonValue, requireJsonValue } from "../../support/providers/responses-conformance";

const secretMaterial = /(?:bearer\s+|sk-[a-z0-9]|api[_-]?key\s*[=:])/i;

describe("OpenAI Responses conformance evidence", () => {
  test("pins relevant Codex source evidence and an application-layer claim", () => {
    expect(profile.evidence.codex.commit).toBe(sourceEvidence.commit);
    expect(profile.evidence.codex.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(profile.evidence.codex.sources.every((source) => /^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(source.lines))).toBe(true);
    const manifestClaims = profile.evidence.codex.sources.map(sourceIdentity);
    const evidenceClaims = sourceEvidence.entries.map(sourceIdentity);
    expect(new Set(manifestClaims).size).toBe(manifestClaims.length);
    expect(new Set(evidenceClaims).size).toBe(evidenceClaims.length);
    expect(new Set(manifestClaims)).toEqual(new Set(evidenceClaims));
    expect(sourceEvidence.entries.every((entry) => entry.path && entry.lines && entry.excerpt.length >= 30)).toBe(true);
    expect(profile.evidence.publicDocs.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(profile.claim.layer).toBe("application");
    expect(profile.claim.excluded).toEqual(expect.arrayContaining([
      "TLS ClientHello and ALPN",
      "HTTP/2 framing and HPACK",
      "Codex private product identity and attestation",
    ]));
  });

  test("classifies every nested captured field and every removed private observation", () => {
    const capturedPaths = new Set<string>();
    const missing: string[] = [];
    for (const capture of captures.captures) {
      const body = requireJsonValue(capture.body, `${capture.id} body`);
      const headers = requireJsonValue(capture.headers, `${capture.id} headers`);
      for (const path of [...collectPaths(headers, "headers"), ...collectPaths(body, "body")]) {
        capturedPaths.add(path);
        const classification = classificationFor(path);
        if (!classification) missing.push(`${capture.id}:${path}`);
        expect(classification?.class).not.toBe("private-identity");
      }
      for (const removedPath of capture.sanitization.removedPrivatePaths) {
        expect(classificationFor(removedPath)?.class).toBe("private-identity");
      }
      expect(Object.keys(capture.body)).toEqual(capture.orderedBodyKeys);
      expect(capture.headers.authorization).toBe("<redacted:name-only>");
    }
    expect(missing).toEqual([]);
    const orphanPublicFields = captures.fieldClassifications
      .filter((field) => field.class === "public-required" || field.class === "public-optional-profiled")
      .filter((field) => !field.path.endsWith("*") && !capturedPaths.has(field.path))
      .map((field) => field.path);
    expect(orphanPublicFields).toEqual([]);
    expect(new Set(captures.fieldClassifications.map((field) => field.class))).toEqual(new Set([
      "public-required", "public-optional-profiled", "transport-derived", "dynamic", "private-identity",
    ]));
  });

  test("contains no secrets and no unsanitized private capture fields", () => {
    for (const fixture of [profile, captures, lifecycle, events, ledger, sourceEvidence]) {
      expect(JSON.stringify(fixture)).not.toMatch(secretMaterial);
    }
  });

  test("requires typed placeholders at every declared dynamic path", () => {
    const placeholder = new RegExp(captures.dynamicPlaceholderPattern);
    const requestRoot = requireJsonValue(captures, "request captures");
    const eventRoot = requireJsonValue(events, "event captures");
    const declaredPaths = [
      ...captures.dynamicValuePaths.map((path) => ({ root: requestRoot, path })),
      ...events.dynamicValuePaths.map((path) => ({ root: eventRoot, path })),
    ];
    const declaredValues = declaredPaths.flatMap(({ root, path }) => {
      const values = valuesAtPath(root, path);
      expect(values.length, `dynamic path ${path}`).toBeGreaterThan(0);
      return values;
    });
    const placeholderValues = collectStrings(requireJsonValue([captures.captures, events.captures], "dynamic fixtures"))
      .filter((value) => value.startsWith("<dynamic:"));
    expect(declaredValues.length).toBeGreaterThan(0);
    expect(declaredValues.filter((value) => typeof value !== "string" || !placeholder.test(value))).toEqual([]);
    expect(declaredValues.length).toBe(placeholderValues.length);
  });

  test("derives public versus Codex-beta differences from the ledger", () => {
    const codex = capture("codex-beta-ws-generate");
    const publicWs = capture("openai-public-ws-generate");
    const decision = ledger.entries.find((entry) => entry.id === "ws-stream-field");
    if (!decision || !("allowedCaptureDifferences" in decision)) throw new Error("Missing executable ws-stream-field ledger differences.");
    expect(compareStructuredCapture(
      requireJsonValue(codex, "Codex WebSocket capture"),
      requireJsonValue(publicWs, "public WebSocket capture"),
      new Set(decision.allowedCaptureDifferences),
    )).toEqual([]);
    expect(new Set(ledger.entries.map((entry) => entry.id))).toEqual(new Set([
      "ws-stream-field",
      "encrypted-reasoning-include",
      "tool-commit-barrier",
      "websocket-owner",
      "private-identity",
      "mimo-subset",
      "deepseek-subset",
      "network-fingerprint",
    ]));
    expect(ledger.entries.every((entry) => entry.codex && entry.public && entry.selected && entry.test)).toBe(true);
  });

  test("defines internally consistent official and third-party Responses profiles", () => {
    const openai = profile.profiles.openaiPublic;
    const codex = profile.profiles.codexBeta20260206;
    const mimo = profile.profiles.mimoSubset20260730;
    const deepseek = profile.profiles.deepseekSubset20260731;
    expect(openai.websocket.profile).toBe("openai-public");
    expect(codex.websocket.profile).toBe("codex-beta-2026-02-06");
    expect(openai.supportedRequestFields).not.toContain("client_metadata");
    expect(codex.supportedRequestFields).not.toContain("client_metadata");
    expect(codex.excludedPrivateFields).toContain("client_metadata");
    expect(mimo).toMatchObject({
      tier: "responses-compatible-subset",
      previousResponseId: false,
      remoteCompact: false,
      websocket: false,
    });
    expect(mimo.supportedRequestFields).toEqual(expect.arrayContaining([
      "reasoning", "temperature", "top_p", "text",
    ]));
    expect(mimo.supportedEventFamilies).toEqual(expect.arrayContaining([
      "response.in_progress", "response.content_part.*", "response.reasoning_text.*",
    ]));
    for (const unsupported of mimo.unsupportedRequestFields) {
      expect(mimo.supportedRequestFields).not.toContain(unsupported);
    }
    expect(deepseek).toMatchObject({
      tier: "responses-compatible-subset",
      previousResponseId: false,
      remoteCompact: false,
      websocket: false,
      supportedModels: ["deepseek-v4-flash"],
    });
    expect(deepseek.supportedEventFamilies).toContain("response.reasoning_text.*");
    for (const unsupported of deepseek.unsupportedRequestFields) {
      expect(deepseek.supportedRequestFields).not.toContain(unsupported);
    }
  });

  test("records the Codex tool-dispatch hazard as a deliberate Vesicle safety divergence", () => {
    expect(lifecycle.retry).toMatchObject({
      maxRetriesBeforeWebSocketDowngrade: 5,
      counterMeaning: "retries after the triggering attempt",
      attemptAccumulatorsAreIsolated: true,
      fallbackTransport: "http",
      cancellationRetries: false,
    });
    expect(lifecycle.commitBarrier.codexFrozenBehavior.toolDispatchMayBeginBeforeCommit).toBe(true);
    expect(lifecycle.commitBarrier.vesicleSelectedBehavior).toEqual({
      toolDispatchBeforeCommit: false,
      failedAttemptDurableOutput: false,
      retrySideEffectCount: 1,
      status: "phase-2-required-safety-divergence",
    });
    const premature = events.captures.find((capture) => capture.id === "codex-premature-eof-after-function-item");
    expect(premature).toMatchObject({
      codexObserved: { toolFutureQueuedAtSequence: 0, toolDrainAfterStreamExit: true },
      vesicleSelected: { committed: false, toolDispatchCount: 0, durableAssistantCount: 0, retryEligible: true },
    });
    expect(ledger.entries.some((entry) => entry.id === "tool-commit-barrier")).toBe(true);
  });

  test("freezes ordered events, output Items, call_id, usage, attempt and terminal variants", () => {
    const completed = events.captures.find((capture) => capture.id === "completed-function-call");
    if (!completed) throw new Error("Missing completed function-call capture.");
    const completedEvents = completed.events;
    const relationships = completed.relationships;
    if (!completedEvents || !relationships) throw new Error("Completed function-call capture is malformed.");
    expect(completedEvents.map((event) => event.sequence)).toEqual(completedEvents.map((_, index) => index));
    expect(completedEvents.at(-1)?.type).toBe("response.completed");
    const functionItem = completedEvents
      .find((event) => "item" in event && event.item?.type === "function_call")?.item;
    if (!("nextRequestInput" in completed)) throw new Error("Completed fixture has no next-request tool output.");
    const toolOutput = completed.nextRequestInput.find((item) => item.type === "function_call_output");
    if (!functionItem || typeof functionItem.call_id !== "string" || !toolOutput) throw new Error("Completed fixture has no paired call Items.");
    expect(functionItem.call_id).toBe(toolOutput.call_id);
    expect(relationships.functionCallId).toBe(functionItem.call_id);
    expect(relationships.toolOutputMustUseCallId).toBe(toolOutput.call_id);
    expect(relationships.terminalCommitSequence).toBe(7);
    const terminal = completedEvents.at(-1);
    expect(terminal).toMatchObject({
      response: { usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } },
    });
    expect(new Set(lifecycle.terminalEvents)).toEqual(new Set([
      "response.completed", "response.failed", "response.incomplete", "error", "premature-eof",
    ]));
  });

  test("rejects non-JSON-safe capture values", () => {
    expect(() => requireJsonValue(new Date(), "date")).toThrow("date is not JSON-safe");
    expect(() => requireJsonValue({ value: BigInt(1) }, "bigint")).toThrow("bigint is not JSON-safe");
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => requireJsonValue(circular, "circular")).toThrow("circular is not JSON-safe");
  });
});

function capture(id: string) {
  const result = captures.captures.find((candidate) => candidate.id === id);
  if (!result) throw new Error(`Missing fixture capture ${id}.`);
  return result;
}

function classificationFor(path: string) {
  return captures.fieldClassifications.find((field) =>
    field.path === path || (field.path.endsWith("*") && path.startsWith(field.path.slice(0, -1))));
}

function sourceIdentity(source: { claimId: string; path: string; lines: string }): string {
  return `${source.claimId}:${source.path}:${source.lines}`;
}

function collectPaths(value: JsonValue, path: string): string[] {
  if (Array.isArray(value)) return value.flatMap((entry) => collectPaths(entry, `${path}[]`));
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => {
    const childPath = `${path}.${key}`;
    return [childPath, ...collectPaths(child, childPath)];
  });
}

function collectStrings(value: JsonValue): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (value && typeof value === "object") return Object.values(value).flatMap(collectStrings);
  return [];
}

function valuesAtPath(root: JsonValue, path: string): JsonValue[] {
  return path.split(".").reduce<JsonValue[]>((values, segment) => {
    const array = segment.endsWith("[]");
    const key = array ? segment.slice(0, -2) : segment;
    return values.flatMap((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value) || !(key in value)) return [];
      const child = value[key];
      return array && Array.isArray(child) ? child : [child];
    });
  }, [root]);
}
