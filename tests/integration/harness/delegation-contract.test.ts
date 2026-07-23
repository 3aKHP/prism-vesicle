
import { describe, expect, test } from "bun:test";
import {
  bindHarnessDelegation,
  HarnessAdapterError,
} from "../../../src/core/harness";
import { harnessRuntime, } from "./fixtures/harness";

describe("harness delegation: delegation contract", () => {
  test("binds all three Weaver-Orch mappings to their fixed contract", () => {
    const runtime = harnessRuntime();
    expect([
      bindHarnessDelegation(runtime, "weaver-orch", "scene-writer"),
      bindHarnessDelegation(runtime, "weaver-orch", "continuity-editor"),
      bindHarnessDelegation(runtime, "weaver-orch", "chapter-reviewer"),
    ]).toEqual([
      expect.objectContaining({ id: "weaver-orch.scene-writer", mode: "foreground", retryLimit: 1 }),
      expect.objectContaining({ id: "weaver-orch.continuity", mode: "foreground", retryLimit: 1 }),
      expect.objectContaining({ id: "weaver-orch.chapter-review", mode: "foreground", retryLimit: 1 }),
    ]);
  });

  test("rejects undeclared parents, profiles, ambiguity, and mode escalation", () => {
    const runtime = harnessRuntime();
    expect(() => bindHarnessDelegation(runtime, "etl", "scene-writer")).toThrow("does not declare Engine");
    expect(() => bindHarnessDelegation(runtime, "weaver-orch", "missing-agent")).toThrow("does not declare delegation");
    expect(() => bindHarnessDelegation(runtime, "weaver-orch", "scene-writer", "background")).toThrow("fixes mode");

    const ambiguous = harnessRuntime();
    ambiguous.driver.engines["weaver-orch"]!.delegations.push({
      id: "weaver-orch.scene-writer-duplicate",
      agent: "scene-writer",
      mode: "foreground",
      purpose: "Duplicate mapping.",
      retryLimit: 1,
    });
    try {
      bindHarnessDelegation(ambiguous, "weaver-orch", "scene-writer");
      throw new Error("expected ambiguous binding to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(HarnessAdapterError);
      expect((error as HarnessAdapterError).category).toBe("conflict");
    }
  });

});
