import { expect, test } from "bun:test";
import { loadConfigForSelection } from "../../../src/config/providers";
import type { VesicleConfig } from "../../../src/config/env";
import { createProvider } from "../../../src/providers";
import { toGeminiGenerateContentBody } from "../../../src/providers/gemini-generate-content/adapter";
import type { ProviderStreamEvent, VesicleRequest } from "../../../src/providers/shared/types";
import { summarize } from "./support";

const providerEnv = "BUN_E2E_GEMINI_IMAGE_TOOL_PROVIDER";
const modelEnv = "BUN_E2E_GEMINI_IMAGE_TOOL_MODEL";

async function resolveGeminiImageToolAcceptance(): Promise<{ config?: VesicleConfig; reason: string }> {
  const providerId = process.env[providerEnv];
  if (process.env.BUN_E2E_REAL_PROVIDER !== "1") {
    return { reason: "BUN_E2E_REAL_PROVIDER=1 is not set" };
  }
  if (!providerId) return { reason: `${providerEnv} is not set` };
  try {
    const model = process.env[modelEnv];
    const config = await loadConfigForSelection({ provider: providerId, ...(model ? { model } : {}) });
    if (config.provider !== "gemini-generate-content") {
      return { reason: `${providerId} is not configured with protocol gemini-generate-content` };
    }
    if (!config.apiKey) return { reason: `${config.apiKeyLabel ?? "provider API key"} is missing` };
    if (config.capabilities?.vision !== true) {
      return { reason: `${providerId}/${config.model} does not declare capabilities.vision: true` };
    }
    return { config, reason: "ok" };
  } catch {
    return { reason: "provider configuration could not be loaded" };
  }
}

const resolved = await resolveGeminiImageToolAcceptance();
if (!resolved.config) console.log(`[acceptance:gemini-image-tool-result] unavailable: ${resolved.reason}`);
const liveTest: typeof test = resolved.config ? test : test.skip;
const label = resolved.config ? `${resolved.config.providerId}/${resolved.config.model}` : `skipped: ${resolved.reason}`;

// Deterministic 16x16 solid-red PNG (81 bytes). The tool-result image is synthesized at
// the normalized request boundary rather than fetched from a live MCP server: the wire
// shape under test (functionResponse Content + separate inlineData Content) is identical,
// and the acceptance record below flags the substitution instead of hiding it.
const redPngBase64 = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAGElEQVR4nGM4ISdHEmIY1TAaSnLDNmkAAORiBBDqzznpAAAAAElFTkSuQmCC";

/**
 * Real Gemini/Vertex native acceptance for the image tool-result Content boundary (#226).
 * The conversation replays an assistant tool call, a tool result carrying an MCP-sourced
 * image, and a follow-up user message. Before the fix this replay serialized
 * functionResponse, text, and inlineData parts into one user Content and the endpoint
 * rejected the request with HTTP 400; the fix must let native streaming continue so the
 * model can respond to the image.
 *
 * Skipped (not passed) when the opt-in env var, the provider selection env var,
 * credentials, or model vision capability is missing, so every gap shows up as "skip".
 */
liveTest(`gemini image tool-result boundary [${label}]`, async () => {
  const config = resolved.config!;
  const adapter = createProvider(config);
  expect(adapter.id).toBe("gemini-generate-content");

  const request: VesicleRequest = {
    id: `acceptance-${crypto.randomUUID()}`,
    model: { provider: config.providerId, model: config.model },
    system: ["You are a verification assistant."],
    tools: [{
      type: "function",
      function: {
        name: "mcp_demo_fetch_artwork",
        description: "Demo MCP tool that returns an artwork image.",
        parameters: { type: "object", properties: {} },
      },
    }],
    messages: [
      { role: "user", content: "Fetch the artwork with the demo MCP tool, then describe it." },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_mcp_img", name: "mcp_demo_fetch_artwork", arguments: "{}" }],
      },
      {
        role: "tool",
        toolCallId: "call_mcp_img",
        content: "fetched artwork image",
        images: [{
          id: "img_mcp_acceptance",
          path: ".vesicle/attachments/acceptance-artwork.png",
          mediaType: "image/png",
          bytes: 81,
          sha256: "5e032d8615fac126693f8d4a12d5008a80ff1794f43cb4982954f7c1f3d458c1",
          source: "mcp",
          sourcePath: "artwork.png",
          filename: "artwork.png",
          data: redPngBase64,
        }],
      },
      { role: "user", content: "In one short sentence, what does the image returned by the tool look like?" },
    ],
  };

  // Guard the exact wire body about to be sent: no user Content may mix functionResponse
  // parts with ordinary text/inlineData parts.
  const body = toGeminiGenerateContentBody(request) as { contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> };
  const userContents = body.contents.filter((content) => content.role === "user");
  const functionResponseContents = userContents.filter((content) => content.parts.some((part) => "functionResponse" in part));
  const imageContents = userContents.filter((content) => content.parts.some((part) => "inlineData" in part));
  expect(functionResponseContents.length).toBe(1);
  expect(imageContents.length).toBe(1);
  for (const content of functionResponseContents) {
    expect(content.parts.every((part) => "functionResponse" in part)).toBe(true);
  }

  const events: ProviderStreamEvent[] = [];
  if (!adapter.stream) throw new Error("gemini adapter does not expose stream()");
  for await (const event of adapter.stream(request)) events.push(event);

  const complete = events.find((event) => event.type === "complete");
  if (complete?.type !== "complete") throw new Error("gemini stream ended without a complete event");
  expect(typeof complete.response.content).toBe("string");
  summarize("gemini-image-tool-result", {
    provider: config.providerId,
    model: config.model,
    imageSource: "synthesized-mcp-boundary",
    functionResponseContents: functionResponseContents.length,
    imageContents: imageContents.length,
    streamEvents: events.length,
    contentLen: complete.response.content.length,
    finishReason: complete.response.finishReason ?? null,
  });
}, 120_000);
