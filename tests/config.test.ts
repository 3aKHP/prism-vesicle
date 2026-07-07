import { describe, expect, test } from "bun:test";
import { inspectConfig, loadConfig } from "../src/config/env";

describe("config loading", () => {
  test("loads OpenAI-compatible defaults", () => {
    const config = loadConfig({});

    expect(config.provider).toBe("openai-chat-compatible");
    expect(config.baseUrl).toBe("https://api.openai.com/v1");
    expect(config.model).toBe("gpt-4.1-mini");
  });

  test("reports missing API key", () => {
    const status = inspectConfig({
      VESICLE_BASE_URL: "https://example.test/v1",
      VESICLE_MODEL: "test-model",
      VESICLE_PROVIDER: "openai-chat-compatible",
    });

    expect(status.hasApiKey).toBe(false);
    expect(status.missing).toContain("VESICLE_API_KEY");
  });
});
