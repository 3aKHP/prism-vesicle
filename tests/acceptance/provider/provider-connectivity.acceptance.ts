import { afterEach, beforeEach, expect, test } from "bun:test";
import { runPrompt } from "../../../src/core/agent-loop/run";
import {
  checkAcceptancePrecondition,
  createAcceptanceRoot,
  removeAcceptanceRoot,
  summarize,
} from "./support";

const precondition = await checkAcceptancePrecondition();
const label = precondition.ok
  ? `${precondition.providerId}/${precondition.model}`
  : `skipped: ${precondition.reason}`;

let rootDir: string | undefined;
beforeEach(async () => {
  if (precondition.ok) rootDir = await createAcceptanceRoot();
});
afterEach(async () => {
  if (rootDir) {
    await removeAcceptanceRoot(rootDir);
    rootDir = undefined;
  }
});

/**
 * Provider connectivity smoke. A single real request must traverse the selected
 * adapter and return a normalizable response shape. This is intentionally
 * lenient about content semantics and which interaction the model chose — it
 * only proves the transport, auth, and response normalization work end to end.
 *
 * Skipped (not passed) when the acceptance precondition is unmet, so a missing
 * opt-in env var or credentials shows up as "skip" rather than a silent pass.
 */
test.skipIf(!precondition.ok)(`provider connectivity smoke [${label}]`, async () => {
  if (!rootDir) throw new Error("acceptance rootDir was not initialized");
  const prompt = "Reply with the single word: ready.";
  const result = await runPrompt({
    input: prompt,
    engine: "etl",
    rootDir,
    messages: [{ role: "user", content: prompt }],
  });

  // Any non-throwing result means the adapter normalized a real provider
  // response. A bad credential, transport, or parse failure throws instead.
  expect(typeof result.kind).toBe("string");
  if (result.kind === "complete") {
    expect(typeof result.response.content).toBe("string");
    summarize("smoke", {
      provider: precondition.providerId,
      model: precondition.model,
      kind: result.kind,
      contentLen: result.response.content.length,
      finishReason: result.response.finishReason ?? null,
    });
    return;
  }
  summarize("smoke", {
    provider: precondition.providerId,
    model: precondition.model,
    kind: result.kind,
  });
}, 60000);
