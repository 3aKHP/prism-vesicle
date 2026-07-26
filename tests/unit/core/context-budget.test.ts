import { describe, expect, test } from "bun:test";
import {
  estimateRequestTokens,
  evaluateBudgetCheck,
  resolveAutoCompactActivation,
  type BudgetInputs,
} from "../../../src/core/compact/context-budget";

const baseInputs = (overrides: Partial<BudgetInputs> = {}): BudgetInputs => ({
  config: { threshold: 0.8 },
  limits: { contextWindow: 10_000 },
  generation: undefined,
  ...overrides,
});

describe("context budget: activation", () => {
  test("missing config never activates", () => {
    expect(resolveAutoCompactActivation(baseInputs({ config: undefined })).kind).toBe("inactive");
  });

  test("enabled: false never activates", () => {
    expect(resolveAutoCompactActivation(baseInputs({ config: { enabled: false, threshold: 0.8 } })).kind).toBe("inactive");
  });

  test("missing threshold never activates", () => {
    expect(resolveAutoCompactActivation(baseInputs({ config: { threshold: undefined } })).kind).toBe("inactive");
  });

  test("threshold outside (0,1) never activates", () => {
    expect(resolveAutoCompactActivation(baseInputs({ config: { threshold: 0 } })).kind).toBe("inactive");
    expect(resolveAutoCompactActivation(baseInputs({ config: { threshold: 1 } })).kind).toBe("inactive");
    expect(resolveAutoCompactActivation(baseInputs({ config: { threshold: 1.5 } })).kind).toBe("inactive");
  });

  test("missing context window never activates", () => {
    expect(resolveAutoCompactActivation(baseInputs({ limits: { contextWindow: undefined } })).kind).toBe("inactive");
    expect(resolveAutoCompactActivation(baseInputs({ limits: { contextWindow: 0 } })).kind).toBe("inactive");
  });

  test("an explicit reserve greater than or equal to the window deactivates", () => {
    const activation = resolveAutoCompactActivation(baseInputs({ config: { threshold: 0.8, reserveOutputTokens: 10_000 } }));
    expect(activation).toEqual({ kind: "inactive", reason: "invalid-reserve" });
  });

  test("a valid config activates with the frozen soft/hard formulas", () => {
    const activation = resolveAutoCompactActivation(baseInputs({ config: { threshold: 0.8, reserveOutputTokens: 2_000 } }));
    expect(activation.kind).toBe("active");
    if (activation.kind !== "active") return;
    // softTrigger = floor(min(10000 * 0.8, 10000 - 2000)) = floor(min(8000, 8000)) = 8000
    expect(activation.softTriggerTokens).toBe(8000);
    // hardCeiling = 10000 - 2000 = 8000
    expect(activation.hardInputCeilingTokens).toBe(8000);
    expect(activation.reserveSource).toBe("explicit");
  });

  test("the soft trigger is the smaller of the threshold share and the effective input budget", () => {
    // A high threshold still caps the soft trigger at the effective input budget.
    const activation = resolveAutoCompactActivation(baseInputs({ config: { threshold: 0.95, reserveOutputTokens: 4_000 } }));
    expect(activation.kind).toBe("active");
    if (activation.kind !== "active") return;
    // softTrigger = floor(min(10000 * 0.95, 10000 - 4000)) = floor(min(9500, 6000)) = 6000
    expect(activation.softTriggerTokens).toBe(6000);
    expect(activation.hardInputCeilingTokens).toBe(6000);
  });
});

describe("context budget: decision", () => {
  const active = (overrides: Partial<BudgetInputs> = {}): BudgetInputs => baseInputs({ config: { threshold: 0.5, reserveOutputTokens: 2_000 }, ...overrides });
  // softTrigger = floor(min(10000*0.5, 8000)) = 5000; hardCeiling = 8000

  test("below the soft trigger sends normally", () => {
    const result = evaluateBudgetCheck(active({ estimatedNextRequestTokens: 3000 }));
    expect(result.kind).toBe("below");
  });

  test("threshold equality triggers (soft)", () => {
    const result = evaluateBudgetCheck(active({ estimatedNextRequestTokens: 5000 }));
    expect(result.kind).toBe("soft-trigger");
  });

  test("between soft and hard is a soft trigger", () => {
    const result = evaluateBudgetCheck(active({ estimatedNextRequestTokens: 7000 }));
    expect(result.kind).toBe("soft-trigger");
  });

  test("equality at the hard ceiling is still sendable (output reserve already deducted)", () => {
    const result = evaluateBudgetCheck(active({ estimatedNextRequestTokens: 8000 }));
    expect(result.kind).toBe("soft-trigger");
  });

  test("above the hard ceiling is a hard ceiling", () => {
    const result = evaluateBudgetCheck(active({ estimatedNextRequestTokens: 9000 }));
    expect(result.kind).toBe("hard-ceiling");
  });

  test("the reserve affects the actual decision", () => {
    // Same projected occupancy (7000); a larger reserve lowers the hard ceiling
    // and can turn a soft trigger into a hard ceiling.
    const small = evaluateBudgetCheck(baseInputs({ config: { threshold: 0.5, reserveOutputTokens: 2_000 }, estimatedNextRequestTokens: 7000 }));
    const large = evaluateBudgetCheck(baseInputs({ config: { threshold: 0.5, reserveOutputTokens: 4_000 }, estimatedNextRequestTokens: 7000 }));
    expect(small.kind).toBe("soft-trigger"); // hard ceiling 8000
    expect(large.kind).toBe("hard-ceiling"); // hard ceiling 6000
  });

  test("provider-observed usage wins over the fallback estimate and the source stays observable", () => {
    // Provider says 7500, estimate says 3000 -> projected takes the provider
    // value and the source is provider.
    const providerHigher = evaluateBudgetCheck(active({ lastContextInputTokens: 7500, estimatedNextRequestTokens: 3000 }));
    expect(providerHigher.kind).toBe("soft-trigger");
    if (providerHigher.kind !== "soft-trigger") return;
    expect(providerHigher.usageSource).toBe("provider");
    expect(providerHigher.projectedTokens).toBeGreaterThanOrEqual(7500);

    // Only the estimate -> source is estimated.
    const estimateOnly = evaluateBudgetCheck(active({ estimatedNextRequestTokens: 7000 }));
    expect(estimateOnly.kind).toBe("soft-trigger");
    if (estimateOnly.kind !== "soft-trigger") return;
    expect(estimateOnly.usageSource).toBe("estimated");
  });

  test("usage and estimate both unavailable is degraded, not a trigger", () => {
    const result = evaluateBudgetCheck(active({ lastContextInputTokens: undefined, estimatedNextRequestTokens: undefined }));
    expect(result.kind).toBe("degraded");
  });
});

describe("context budget: estimator", () => {
  test("estimates roughly ceil(bytes/2) plus per-message overhead", () => {
    const estimate = estimateRequestTokens([{ role: "user", content: "a".repeat(100) }]);
    // 100 bytes / 2 = 50, plus one per-message overhead of 4 -> at least 50.
    expect(estimate).toBeGreaterThanOrEqual(50);
    expect(estimate).toBeLessThan(200);
  });

  test("excludes base64 image payloads from the transcript size", () => {
    const withoutImage = estimateRequestTokens([{ role: "user", content: "short" }]);
    const withImage = estimateRequestTokens([{ role: "user", content: "short", images: [{ id: "x", path: "p", mediaType: "image/png", bytes: 100_000, sha256: "a", source: "clipboard", data: "x".repeat(100_000) } as never] }]);
    // Image base64 is not counted; only the small content difference + overhead.
    expect(withImage - withoutImage).toBeLessThan(50);
  });
});
