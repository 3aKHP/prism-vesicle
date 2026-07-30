import { expect, test } from "bun:test";
import { resolveResponsesAcceptance } from "./responses-support";

test("Responses acceptance configuration failures never echo loader details", async () => {
  const selector = "VESICLE_TEST_RESPONSES_PROVIDER";
  const previous = process.env[selector];
  process.env[selector] = "secret-shaped-provider-marker";
  try {
    const result = await resolveResponsesAcceptance({
      providerEnv: selector,
      modelEnv: "VESICLE_TEST_RESPONSES_MODEL",
      profile: "openai-public",
    });
    expect(result).toEqual({ reason: "provider configuration could not be loaded" });
    expect(result.reason).not.toContain("secret-shaped-provider-marker");
  } finally {
    if (previous === undefined) delete process.env[selector];
    else process.env[selector] = previous;
  }
});
