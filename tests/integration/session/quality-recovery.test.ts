import { mkdtemp, } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { createSessionStore, loadSessionSnapshot } from "../../../src/core/session/store";

describe("session: quality recovery", () => {
  test("normalizes legacy QualityEvent decisions without inventing new durable fields", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-session-quality-legacy-"));
    const store = await createSessionStore(rootDir, "quality-legacy");
    await store.append({ role: "system", content: "system" });
    await store.append({
      role: "system",
      content: "",
      metadata: {
        kind: "quality-event",
        qualityEvent: {
          guard: "anti-ai-flavor",
          packId: "legacy-pack",
          packVersion: "1.0.0",
          manifestSha256: "a".repeat(64),
          ruleVersion: "0.2.1",
          ruleSourceHash: "b".repeat(64),
          producer: "runtime",
          candidateType: "runtime.prose",
          candidateHash: "c".repeat(64),
          mode: "rewrite",
          attempt: 0,
          decision: "pass",
          findingIds: ["legacy-tier2"],
          detectorMs: 1,
        },
      },
    });
    const snapshot = await loadSessionSnapshot(rootDir, store.sessionId, { synthesizeDanglingToolResults: false });
    expect(snapshot.qualityEvents).toEqual([
      expect.objectContaining({
        decision: "pass",
        outcome: "findings",
        action: "deliver",
        policyVersion: "quality-policy/v1",
        targets: [expect.objectContaining({ findingIds: ["legacy-tier2"], status: "findings" })],
      }),
    ]);
  });

  test("restores detector work-budget warnings as durable inconclusive targets", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-session-quality-budget-"));
    const store = await createSessionStore(rootDir, "quality-detector-budget");
    const target = {
      id: "assistant:dense",
      kind: "assistant-response" as const,
      candidateHash: "d".repeat(64),
      status: "warning" as const,
      findingIds: ["dense-document-metric"],
      findings: [],
      warningReason: "detector-budget-exhausted" as const,
    };
    await store.append({ role: "system", content: "system" });
    await store.append({
      role: "system",
      content: "quality check work limit reached",
      metadata: {
        kind: "quality-warning",
        qualityWarning: {
          id: "quality-warning_budget",
          guard: "anti-ai-flavor",
          reason: "detector-budget-exhausted",
          producer: "runtime",
          attempt: 0,
          targets: [target],
        },
      },
    });
    const snapshot = await loadSessionSnapshot(rootDir, store.sessionId, { synthesizeDanglingToolResults: false });
    expect(snapshot.qualityWarnings).toEqual([
      expect.objectContaining({
        reason: "detector-budget-exhausted",
        targets: [expect.objectContaining({ warningReason: "detector-budget-exhausted" })],
      }),
    ]);
  });

  test("applies quality resolutions in record order when a target re-enters the same warning", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-session-quality-order-"));
    const store = await createSessionStore(rootDir, "quality-resolution-order");
    const target = (path: string) => ({
      id: `artifact:${path}`,
      kind: "artifact-post-image",
      path,
      candidateHash: path.endsWith("a.md") ? "a".repeat(64) : "b".repeat(64),
      bytes: 8,
      status: "warning",
      findingIds: ["zh-f0-air-thick-with"],
      findings: [{
        ruleId: "zh-f0-air-thick-with",
        title: "air thick with",
        severity: "tier1",
        maturity: "stable",
        evidence: "空气中弥漫着",
        source: "detector",
      }],
    });
    const warning = {
      id: "quality-warning_reentered",
      guard: "anti-ai-flavor",
      reason: "exhausted",
      producer: "runtime",
      attempt: 2,
      targets: [target("workspace/a.md"), target("workspace/b.md")],
    };
    await store.appendMany([
      { role: "system", content: "", metadata: { kind: "quality-warning", qualityWarning: warning } },
      {
        role: "system",
        content: "",
        metadata: {
          kind: "quality-resolution",
          qualityResolution: {
            warningId: warning.id,
            resolution: "revised-clean",
            targetIds: ["artifact:workspace/a.md"],
          },
        },
      },
      { role: "system", content: "", metadata: { kind: "quality-warning", qualityWarning: warning } },
    ]);

    const snapshot = await loadSessionSnapshot(rootDir, store.sessionId, { synthesizeDanglingToolResults: false });
    expect(snapshot.qualityWarnings).toEqual([
      expect.objectContaining({
        id: warning.id,
        targets: [
          expect.objectContaining({ path: "workspace/a.md" }),
          expect.objectContaining({ path: "workspace/b.md" }),
        ],
      }),
    ]);
  });
});
