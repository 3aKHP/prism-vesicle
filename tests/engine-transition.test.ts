import { describe, expect, test } from "bun:test";
import {
  ENGINE_HANDOFF_KIND,
  createManualEngineTransition,
  createModelEngineTransition,
  engineContextPolicies,
  renderEngineHandoffPacket,
} from "../src/core/engine/transition";

describe("engine transitions", () => {
  test("reserves preserve_full, summary, and fresh context policies", () => {
    expect(engineContextPolicies).toEqual(["preserve_full", "summary", "fresh"]);
    expect(ENGINE_HANDOFF_KIND).toBe("engine-handoff");
  });

  test("creates a manual direct transition with a provider-neutral handoff packet", () => {
    const transition = createManualEngineTransition("etl", "runtime");
    expect(transition).toMatchObject({
      source: "manual",
      decision: "direct",
      fromEngine: "etl",
      toEngine: "runtime",
      contextPolicy: "preserve_full",
    });

    const packet = renderEngineHandoffPacket(transition);
    expect(packet).toContain("[engine_handoff]");
    expect(packet).toContain("Source: manual");
    expect(packet).toContain("From Engine: etl");
    expect(packet).toContain("To Engine: runtime");
    expect(packet).toContain("Context Policy: preserve_full");
    expect(packet).toContain("[/engine_handoff]");
  });

  test("creates a model-request transition from the tool request", () => {
    const transition = createModelEngineTransition("etl", {
      targetEngine: "runtime",
      reason: "Turn simulation is next.",
      handoffSummary: "Cards are ready.",
      recommendedNextAction: "Simulate the first turn.",
    }, "confirmed");

    expect(transition).toMatchObject({
      source: "model_request",
      decision: "confirmed",
      fromEngine: "etl",
      toEngine: "runtime",
      reason: "Turn simulation is next.",
      handoffSummary: "Cards are ready.",
      recommendedNextAction: "Simulate the first turn.",
      contextPolicy: "preserve_full",
    });
    expect(renderEngineHandoffPacket(transition)).toContain("Recommended Next Action:\nSimulate the first turn.");
  });

  test("creates a rejected model-request transition", () => {
    const transition = createModelEngineTransition("etl", {
      targetEngine: "runtime",
      reason: "Turn simulation is next.",
      handoffSummary: "Cards are ready.",
    }, "rejected");

    expect(transition).toMatchObject({
      source: "model_request",
      decision: "rejected",
      fromEngine: "etl",
      toEngine: "runtime",
      contextPolicy: "preserve_full",
    });
  });
});
