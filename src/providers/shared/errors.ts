export type ProviderErrorKind =
  | "missing_credentials"
  | "http_error"
  | "network_error"
  | "stream_error"
  | "malformed_response";

export type ProviderErrorOptions = {
  kind: ProviderErrorKind;
  providerId?: string;
  status?: number;
  retryable?: boolean;
  attempts?: number;
  /** Provider-owned machine-readable error code; never inferred from prose. */
  code?: string;
  cause?: unknown;
};

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly providerId?: string;
  readonly status?: number;
  readonly retryable: boolean;
  readonly attempts?: number;
  readonly code?: string;

  constructor(message: string, options: ProviderErrorOptions) {
    super(message, { cause: options.cause });
    this.name = "ProviderError";
    this.kind = options.kind;
    this.providerId = options.providerId;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
    this.attempts = options.attempts;
    this.code = options.code;
  }
}

export function abortError(signal?: AbortSignal): DOMException {
  return new DOMException(
    typeof signal?.reason === "string" ? signal.reason : "The operation was aborted.",
    "AbortError",
  );
}

/**
 * Collapse control characters and excessive whitespace and cap length so a
 * provider-supplied error string can never break TUI layout or pour an
 * unbounded response body onto the conversation surface. Single-line output.
 */
const PROVIDER_MESSAGE_MAX_LENGTH = 240;

/**
 * Unicode format / bidirectional-override code points that are invisible or
 * directionally active and have no place in a displayed error message:
 * zero-width and BIDI marks (U+200B-U+200F), directional overrides
 * (U+202A-U+202E), BIDI isolates (U+2066-U+2069), and the BOM (U+FEFF).
 * Listed by code point so the source stays pure ASCII and never embeds
 * direction-override literals (Trojan-Source risk).
 */
const UNICODE_FORMAT_CODEPOINTS = new Set([
  0x200b, 0x200c, 0x200d, 0x200e, 0x200f,
  0x202a, 0x202b, 0x202c, 0x202d, 0x202e,
  0x2066, 0x2067, 0x2068, 0x2069,
  0xfeff,
]);

export function cleanProviderMessage(raw: string, maxLength = PROVIDER_MESSAGE_MAX_LENGTH): string {
  const stripped = raw.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\x80-\x9F]/g, "");
  const filtered = Array.from(stripped)
    .filter((char) => !UNICODE_FORMAT_CODEPOINTS.has(char.codePointAt(0) ?? -1))
    .join("");
  const collapsed = filtered.replace(/\s+/g, " ").trim();
  const chars = Array.from(collapsed);
  return chars.length <= maxLength ? collapsed : `${chars.slice(0, maxLength - 1).join("")}…`;
}

/**
 * User-facing classification of a provider failure, derived from `ProviderError`
 * kind/status. Independent of adapter protocol so OpenAI-compatible, Anthropic
 * Messages, and Gemini share one presentation vocabulary.
 */
export type ProviderFailureCategory =
  | "credentials"
  | "balance"
  | "not_found"
  | "rate_limited"
  | "server"
  | "network"
  | "stream"
  | "malformed"
  | "unknown";

export type ProviderFailureSummary = {
  category: ProviderFailureCategory;
  status?: number;
  providerId?: string;
  retryable: boolean;
  /** Cleaned, single-line, length-bounded provider message. */
  message: string;
};

/**
 * Reduce any thrown value to a presentable provider failure. `ProviderError`
 * keeps its structured kind/status; anything else becomes `unknown`. The host
 * UI consumes this instead of raw `error.message` so category, status, and
 * retryability stay available for rendering and (later) retry affordances.
 */
export function summarizeProviderFailure(error: unknown): ProviderFailureSummary {
  if (error instanceof ProviderError) {
    const category = providerFailureCategory(error);
    return {
      category,
      status: error.status,
      providerId: error.providerId,
      retryable: error.retryable || isRetryableCategory(category),
      message: cleanProviderMessage(error.message),
    };
  }
  const message = error instanceof Error && error.message.trim() ? error.message : String(error);
  return {
    category: "unknown",
    retryable: false,
    message: cleanProviderMessage(message),
  };
}

function providerFailureCategory(error: ProviderError): ProviderFailureCategory {
  switch (error.kind) {
    case "missing_credentials": return "credentials";
    case "network_error": return "network";
    case "stream_error": return "stream";
    case "malformed_response": return "malformed";
    case "http_error": {
      const status = error.status;
      if (status === 401 || status === 403) return "credentials";
      if (status === 402) return "balance";
      if (status === 404) return "not_found";
      if (status === 408) return "network";
      if (status === 429) return "rate_limited";
      if (status !== undefined && status >= 500) return "server";
      return "unknown";
    }
  }
}

function isRetryableCategory(category: ProviderFailureCategory): boolean {
  return category === "network" || category === "server" || category === "rate_limited" || category === "stream";
}

export type ProviderFailureLabel = { title: string; hint: string };

/**
 * One-line title + actionable hint per category. The title feeds the failure
 * header and the sidebar status line; the hint tells the user what to do.
 */
export function providerFailureCategoryLabel(category: ProviderFailureCategory): ProviderFailureLabel {
  switch (category) {
    case "credentials": return { title: "provider auth failed", hint: "check this provider's API key / authorization" };
    case "balance": return { title: "payment required", hint: "check this provider account's balance or billing plan" };
    case "not_found": return { title: "not found", hint: "check the model id and endpoint URL" };
    case "rate_limited": return { title: "rate limited", hint: "wait briefly and resend" };
    case "server": return { title: "provider server error", hint: "this looks transient — try again" };
    case "network": return { title: "network error", hint: "this looks transient — check connectivity and try again" };
    case "stream": return { title: "stream interrupted", hint: "the response stream broke — try again" };
    case "malformed": return { title: "unparseable response", hint: "the provider returned a response Vesicle could not read" };
    case "unknown": return { title: "provider error", hint: "" };
  }
}
