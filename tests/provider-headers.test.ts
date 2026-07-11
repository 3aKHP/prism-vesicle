import { describe, expect, test } from "bun:test";
import packageJson from "../package.json";
import {
  anthropicMessagesHeaders,
  defaultUserAgent,
  geminiGenerateContentHeaders,
  openAIChatHeaders,
} from "../src/providers/shared/headers";

describe("provider request header profiles", () => {
  test("builds the default branded user agent from runtime version sources", () => {
    expect(defaultUserAgent()).toBe(`prism-vesicle/${packageJson.version} runtime/bun/${Bun.version}`);
  });

  test("matches the OpenCode Chat Completions application headers", () => {
    expect(openAIChatHeaders()).toEqual({
      accept: "*/*",
      "content-type": "application/json",
      "user-agent": defaultUserAgent(),
    });
  });

  test("matches the Claude Code Messages application fingerprint except for UA", () => {
    const headers = anthropicMessagesHeaders("custom-provider/1.0");
    expect(headers).toMatchObject({
      accept: "application/json",
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
      "content-type": "application/json",
      "user-agent": "custom-provider/1.0",
      "x-app": "cli",
      "x-stainless-lang": "js",
      "x-stainless-package-version": "0.94.0",
      "x-stainless-retry-count": "0",
      "x-stainless-runtime": "node",
      "x-stainless-runtime-version": process.version,
      "x-stainless-timeout": "600",
    });
    expect(headers["anthropic-beta"]).toContain("claude-code-20250219");
    expect(headers["anthropic-beta"]).toContain("mid-conversation-system-2026-04-07");
    expect(headers).not.toHaveProperty("accept-encoding");
  });

  test("matches the Gemini CLI SDK client header except for UA", () => {
    expect(geminiGenerateContentHeaders("custom-provider/1.0")).toEqual({
      "content-type": "application/json",
      "user-agent": "custom-provider/1.0",
      "x-goog-api-client": `google-genai-sdk/1.30.0 gl-node/${process.version}`,
    });
  });
});
