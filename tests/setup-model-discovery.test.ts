import { describe, expect, test } from "bun:test";
import {
  discoverOpenAIModels,
  modelIdsFromResponse,
  normalizeOpenAIBaseUrl,
} from "../src/setup/model-discovery";

describe("guided Setup model discovery", () => {
  test("normalizes root and versioned OpenAI-compatible URLs", () => {
    expect(normalizeOpenAIBaseUrl("https://api.example.com")).toBe("https://api.example.com/v1");
    expect(normalizeOpenAIBaseUrl("https://api.example.com/openai/v1/")).toBe("https://api.example.com/openai/v1");
    expect(normalizeOpenAIBaseUrl("http://127.0.0.1:11434")).toBe("http://127.0.0.1:11434/v1");
    expect(() => normalizeOpenAIBaseUrl("http://api.example.com/v1")).toThrow("Use HTTPS");
    expect(() => normalizeOpenAIBaseUrl("https://user:pass@example.com/v1")).toThrow("must not contain");
  });

  test("extracts unique model ids in stable display order", () => {
    expect(modelIdsFromResponse({ data: [{ id: "zeta" }, { id: "alpha" }, { id: "alpha" }, {}] }))
      .toEqual(["alpha", "zeta"]);
    expect(modelIdsFromResponse({ models: ["wrong-shape"] })).toEqual([]);
  });

  test("uses Bearer auth and the resolved /v1/models endpoint", async () => {
    let request: Request | undefined;
    const result = await discoverOpenAIModels("https://api.example.com", "secret-key", {
      fetchImpl: async (input, init) => {
        request = new Request(input, init);
        return Response.json({ data: [{ id: "model-b" }, { id: "model-a" }] });
      },
    });
    expect(request?.url).toBe("https://api.example.com/v1/models");
    expect(request?.headers.get("authorization")).toBe("Bearer secret-key");
    expect(request?.redirect).toBe("error");
    expect(result).toEqual({
      baseUrl: "https://api.example.com/v1",
      endpoint: "https://api.example.com/v1/models",
      models: ["model-a", "model-b"],
    });
  });

  test("returns friendly auth and empty-list failures without exposing the key", async () => {
    await expect(discoverOpenAIModels("https://api.example.com/v1", "top-secret", {
      fetchImpl: async () => new Response("denied", { status: 401 }),
    })).rejects.toThrow("rejected the API key");
    await expect(discoverOpenAIModels("https://api.example.com/v1", "top-secret", {
      fetchImpl: async () => Response.json({ data: [] }),
    })).rejects.toThrow("no model ids");
  });

  test("stops reading a chunked response at the configured byte limit", async () => {
    await expect(discoverOpenAIModels("https://api.example.com/v1", "secret", {
      maxBytes: 10,
      fetchImpl: async () => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"data":['));
          controller.enqueue(new TextEncoder().encode('{"id":"too-large"}]}'));
          controller.close();
        },
      })),
    })).rejects.toThrow("too large");
  });
});
