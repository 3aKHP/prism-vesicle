import { describe, expect, it } from "bun:test";
import {
  ProviderError,
  cleanProviderMessage,
  providerFailureCategoryLabel,
  summarizeProviderFailure,
} from "../../../src/providers/shared/errors";

describe("cleanProviderMessage", () => {
  it("strips control characters and collapses whitespace to one line", () => {
    expect(cleanProviderMessage("a\x00b\x07c\n\n  d")).toBe("abc d");
  });

  it("preserves short messages unchanged", () => {
    expect(cleanProviderMessage("ok")).toBe("ok");
  });

  it("strips Unicode format and bidirectional-override characters", () => {
    const raw = String.fromCodePoint(0x61, 0x200b, 0x62, 0x202e, 0x63, 0xfeff);
    expect(cleanProviderMessage(raw)).toBe("abc");
  });

  it("truncates on a code-point boundary, never leaving a lone surrogate", () => {
    const emoji = String.fromCodePoint(0x1f600).repeat(5);
    const expected = String.fromCodePoint(0x1f600);
    expect(Array.from(cleanProviderMessage(emoji, 3))).toEqual([expected, expected, "…"]);
  });

  it("truncates overlong messages to the limit with an ellipsis", () => {
    const out = cleanProviderMessage("x".repeat(300), 10);
    expect(out).toBe("xxxxxxxxx…");
    expect(out.length).toBe(10);
  });
});

describe("summarizeProviderFailure", () => {
  it("classifies HTTP 402 as a balance failure (the dogfood MiMo case)", () => {
    const error = new ProviderError("Provider request failed (402): Insufficient account balance", {
      kind: "http_error",
      status: 402,
      providerId: "mimo",
    });
    const summary = summarizeProviderFailure(error);
    expect(summary.category).toBe("balance");
    expect(summary.status).toBe(402);
    expect(summary.providerId).toBe("mimo");
    expect(summary.retryable).toBe(false);
    expect(summary.message).toContain("Insufficient account balance");
  });

  it("classifies 401 and 403 as credentials", () => {
    for (const status of [401, 403]) {
      const summary = summarizeProviderFailure(new ProviderError(`(${status})`, { kind: "http_error", status }));
      expect(summary.category).toBe("credentials");
      expect(summary.retryable).toBe(false);
    }
  });

  it("classifies missing_credentials as credentials", () => {
    const summary = summarizeProviderFailure(new ProviderError("no key", { kind: "missing_credentials" }));
    expect(summary.category).toBe("credentials");
  });

  it("classifies 404 as not_found", () => {
    expect(summarizeProviderFailure(new ProviderError("(404)", { kind: "http_error", status: 404 })).category).toBe("not_found");
  });

  it("classifies an unmapped 4xx (e.g. 400) as unknown and non-retryable", () => {
    const summary = summarizeProviderFailure(new ProviderError("(400)", { kind: "http_error", status: 400 }));
    expect(summary.category).toBe("unknown");
    expect(summary.retryable).toBe(false);
  });

  it("classifies 429 as rate_limited and marks it retryable", () => {
    const summary = summarizeProviderFailure(new ProviderError("(429)", { kind: "http_error", status: 429 }));
    expect(summary.category).toBe("rate_limited");
    expect(summary.retryable).toBe(true);
  });

  it("classifies 5xx as server and marks it retryable", () => {
    const summary = summarizeProviderFailure(new ProviderError("(503)", { kind: "http_error", status: 503 }));
    expect(summary.category).toBe("server");
    expect(summary.retryable).toBe(true);
  });

  it("classifies network_error as network", () => {
    const summary = summarizeProviderFailure(new ProviderError("network down", { kind: "network_error", retryable: true }));
    expect(summary.category).toBe("network");
    expect(summary.retryable).toBe(true);
  });

  it("classifies stream_error as stream and marks it retryable", () => {
    const summary = summarizeProviderFailure(new ProviderError("cut", { kind: "stream_error" }));
    expect(summary.category).toBe("stream");
    expect(summary.retryable).toBe(true);
  });

  it("classifies malformed_response as malformed", () => {
    expect(summarizeProviderFailure(new ProviderError("bad body", { kind: "malformed_response" })).category).toBe("malformed");
  });

  it("reduces non-ProviderError throws to unknown without retry", () => {
    const summary = summarizeProviderFailure(new Error("boom"));
    expect(summary.category).toBe("unknown");
    expect(summary.retryable).toBe(false);
    expect(summary.message).toBe("boom");
  });

  it("cleans and bounds the carried message", () => {
    const summary = summarizeProviderFailure(new ProviderError("x".repeat(300), { kind: "http_error", status: 500 }));
    expect(summary.message.length).toBeLessThanOrEqual(240);
    expect(summary.message.endsWith("…")).toBe(true);
  });
});

describe("providerFailureCategoryLabel", () => {
  it("returns a non-empty title for every category", () => {
    const categories = ["credentials", "balance", "not_found", "rate_limited", "server", "network", "stream", "malformed", "unknown"] as const;
    for (const category of categories) {
      expect(providerFailureCategoryLabel(category).title.length).toBeGreaterThan(0);
    }
  });

  it("gives the balance category an actionable hint", () => {
    expect(providerFailureCategoryLabel("balance").hint).toContain("balance");
  });
});
