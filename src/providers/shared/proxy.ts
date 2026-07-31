import { createHash } from "node:crypto";
import { ProviderError } from "./errors";

/**
 * Provider proxy policy, resolver, redaction, and diagnostics.
 *
 * Sole owner of how provider HTTP and WebSocket connections are routed through
 * a proxy. Loaded once with provider configuration and handed through the
 * provider construction path; runtime-only, like the API key and callbacks. It
 * never enters {@link VesicleRequest}, provider state envelopes, session events,
 * quality identity, or provider registry serialization.
 *
 * The inherited-environment selection and `NO_PROXY` grammar mirror the pinned
 * Bun runtime's verified behavior (see `dev/docs/working/ISSUE_150_PROVIDER_PROXY_DESIGN.md`
 * §0) so that native WebSocket — which ignores proxy env vars — selects the same
 * route as `fetch`, which defers to Bun. The public contract documents only what
 * the pinned runtime actually honors.
 */

/** Canonical Vesicle proxy setting in the user-level `.env` beside `providers.yaml`. */
export const PROVIDER_PROXY_ENV_KEY = "VESICLE_PROVIDER_PROXY";

export type ProxySource = "user-file" | "process-vesicle" | "process-standard" | "none";

export type StandardProxyVariable = "HTTPS_PROXY" | "https_proxy" | "HTTP_PROXY" | "http_proxy";

/**
 * Validated, non-revealing proxy URL. The normalized URL (including any Basic
 * credentials) is held privately and escapes only through {@link SecretProxyUrl.forBun},
 * which is called at the exact `fetch` / `new WebSocket` call site. It has no
 * revealing `toString`, `toJSON`, or inspect representation.
 */
export type SecretProxyUrl = {
  readonly scheme: "http" | "https";
  readonly authConfigured: boolean;
  /** The proxy URL for Bun's `proxy` option only. Never logged or serialized. */
  forBun(): string;
};

/** A resolved inherited standard-env candidate for one destination scheme. */
export type StandardProxyCandidate = {
  secretUrl: SecretProxyUrl;
  variable: StandardProxyVariable;
};

export type ProviderProxyPolicy =
  | { kind: "explicit"; secretUrl: SecretProxyUrl; source: "user-file" | "process-vesicle" }
  | { kind: "environment"; secure?: StandardProxyCandidate; plain?: StandardProxyCandidate; noProxy?: string }
  | { kind: "direct" };

export type ProviderProxyRoute =
  | { kind: "transport-default" }
  | { kind: "direct"; reason: "none" | "no-proxy" }
  | { kind: "proxy"; secretUrl: SecretProxyUrl; source: ProxySource; auth: "none" | "basic" };

export type ProviderProxyDiagnostic = {
  route: "direct" | "proxy-configured" | "bypassed";
  source: ProxySource;
  variable?: "VESICLE_PROVIDER_PROXY" | StandardProxyVariable;
  scheme?: "http" | "https";
  authConfigured?: boolean;
};

/** A non-empty (after trim) value, or `undefined` when absent/blank. */
function nonBlank(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Validate a Vesicle proxy URL. Accepted: absolute `http:`/`https:` URL with a
 * non-empty host, empty-or-`/` path, no query or fragment, optional URL
 * userinfo (Basic auth). No separate header map. Invalid values fail with a
 * fixed safe message and code; the supplied value is never interpolated and no
 * URL-bearing parse error is preserved as a public `cause`.
 */
export function validateProxyUrl(raw: string): SecretProxyUrl {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalidProxyConfig();
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ProviderError("Provider proxy URL must use http or https.", {
      kind: "network_error",
      code: "unsupported_proxy_scheme",
      retryable: false,
    });
  }
  if (!url.hostname) throw invalidProxyConfig();
  if (url.pathname !== "/" && url.pathname !== "") throw invalidProxyConfig();
  if (url.search || url.hash) throw invalidProxyConfig();
  // Normalize once: canonicalizes default ports and collapses the path to "/".
  const normalized = url.toString();
  const authConfigured = Boolean(url.username) || Boolean(url.password);
  return {
    scheme: url.protocol === "https:" ? "https" : "http",
    authConfigured,
    forBun: () => normalized,
  };
}

/** Lenient parse for inherited standard-env candidates: absent on any failure. */
function tryParseProxyUrl(raw: string): SecretProxyUrl | undefined {
  try {
    return validateProxyUrl(raw);
  } catch {
    return undefined;
  }
}

function invalidProxyConfig(): ProviderError {
  return new ProviderError(
    "Provider proxy URL is invalid. Set VESICLE_PROVIDER_PROXY to a complete http:// or https:// URL.",
    { kind: "network_error", code: "invalid_proxy_config", retryable: false },
  );
}

/**
 * Resolve the proxy policy from the separately-retained user-file and process
 * maps. Sources are not merged: an explicit Vesicle key wins over every
 * inherited terminal variable, user-file wins over process, and a blank value
 * is absent (it falls through, it never means "direct"). Standard proxy names
 * are read only from the process environment.
 *
 * Inherited candidates are validated once here into non-revealing
 * {@link SecretProxyUrl} values (raw URLs are never retained), so downstream
 * resolvers are pure functions of the policy and destination.
 */
export function loadProviderProxyPolicy(args: {
  userFileEnv: NodeJS.ProcessEnv;
  processEnv: NodeJS.ProcessEnv;
}): ProviderProxyPolicy {
  const { userFileEnv, processEnv } = args;
  const userFileValue = nonBlank(userFileEnv[PROVIDER_PROXY_ENV_KEY]);
  if (userFileValue) {
    return { kind: "explicit", secretUrl: validateProxyUrl(userFileValue), source: "user-file" };
  }
  const processValue = nonBlank(processEnv[PROVIDER_PROXY_ENV_KEY]);
  if (processValue) {
    return { kind: "explicit", secretUrl: validateProxyUrl(processValue), source: "process-vesicle" };
  }
  const secure = selectStandardCandidate(true, processEnv);
  const plain = selectStandardCandidate(false, processEnv);
  if (!secure && !plain) return { kind: "direct" };
  return { kind: "environment", secure, plain, noProxy: effectiveNoProxy(processEnv) };
}

/**
 * `NO_PROXY` matching, mirroring the pinned Bun runtime's verified grammar:
 * `*` matches all; comma-separated entries with surrounding whitespace ignored;
 * exact hostname, case-insensitive; a leading dot means a domain suffix and also
 * matches the bare suffix host; IPv4/IPv6 literals. Port-restricted entries and
 * `*.` wildcards are intentionally NOT supported — the runtime does not support
 * them, so implementing them would make native WebSocket diverge from `fetch`.
 * Malformed entries are ignored individually.
 */
export function matchesNoProxy(noProxy: string, host: string): boolean {
  const target = host.toLowerCase().replace(/^\[|\]$/g, "");
  for (const rawEntry of noProxy.split(",")) {
    const entry = rawEntry.trim().toLowerCase();
    if (!entry) continue;
    if (entry === "*") return true;
    if (entry.startsWith(".")) {
      const suffix = entry.slice(1);
      if (target === suffix || target.endsWith(entry)) return true;
      continue;
    }
    if (entry === target) return true;
  }
  return false;
}

/** Read the effective `NO_PROXY` value: uppercase wins; a blank value is absent. */
function effectiveNoProxy(processEnv: NodeJS.ProcessEnv): string | undefined {
  return nonBlank(processEnv.NO_PROXY) ?? nonBlank(processEnv.no_proxy);
}

/**
 * Select an inherited standard-env proxy candidate for a destination scheme,
 * mirroring the runtime: `https_proxy` then `HTTPS_PROXY` for secure targets,
 * `http_proxy` then `HTTP_PROXY` for plain targets. `ALL_PROXY` is not honored
 * (the runtime ignores it). Lowercase is preferred when both case variants are
 * set, matching the runtime. Malformed values are skipped (absent).
 */
function selectStandardCandidate(
  secure: boolean,
  processEnv: NodeJS.ProcessEnv,
): StandardProxyCandidate | undefined {
  const names = secure
    ? (["https_proxy", "HTTPS_PROXY"] as const)
    : (["http_proxy", "HTTP_PROXY"] as const);
  for (const name of names) {
    const raw = nonBlank(processEnv[name]);
    if (!raw) continue;
    const secretUrl = tryParseProxyUrl(raw);
    if (secretUrl) return { secretUrl, variable: name };
  }
  return undefined;
}

/** Resolve the HTTP fetch route. Explicit ⇒ proxy option; everything else defers to Bun. */
export function resolveHttpRoute(policy: ProviderProxyPolicy): ProviderProxyRoute {
  if (policy.kind === "explicit") {
    return {
      kind: "proxy",
      secretUrl: policy.secretUrl,
      source: policy.source,
      auth: policy.secretUrl.authConfigured ? "basic" : "none",
    };
  }
  // Inherited and direct: omit the option. Bun owns standard-env selection and
  // NO_PROXY for fetch; native behavior is the parity oracle for WebSocket.
  return { kind: "transport-default" };
}

/**
 * Resolve the native WebSocket route. Native WebSocket ignores proxy env vars,
 * so the resolver mirrors Bun's secure-target selection and NO_PROXY grammar and
 * returns either an explicit proxy option or direct. An explicit Vesicle proxy
 * is never bypassed by terminal NO_PROXY.
 */
export function resolveWebSocketRoute(destination: URL, policy: ProviderProxyPolicy): ProviderProxyRoute {
  if (policy.kind === "explicit") {
    return {
      kind: "proxy",
      secretUrl: policy.secretUrl,
      source: policy.source,
      auth: policy.secretUrl.authConfigured ? "basic" : "none",
    };
  }
  if (policy.kind === "direct") return { kind: "direct", reason: "none" };

  const secure = destination.protocol === "https:" || destination.protocol === "wss:";
  const candidate = secure ? policy.secure : policy.plain;
  if (!candidate) return { kind: "direct", reason: "none" };
  if (policy.noProxy && matchesNoProxy(policy.noProxy, destination.hostname)) {
    return { kind: "direct", reason: "no-proxy" };
  }
  return {
    kind: "proxy",
    secretUrl: candidate.secretUrl,
    source: "process-standard",
    auth: candidate.secretUrl.authConfigured ? "basic" : "none",
  };
}

/** In-memory route fingerprint for WebSocket socket ownership only. */
export function proxyRouteFingerprint(route: ProviderProxyRoute): string {
  const version = "v1";
  if (route.kind === "transport-default") return hash(`${version}:default`);
  if (route.kind === "direct") return hash(`${version}:direct:${route.reason}`);
  return hash(`${version}:proxy:${route.source}:${route.secretUrl.forBun()}`);
}

function hash(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Bounded, non-revealing Doctor view for the selected provider destination.
 * Reports route state, source class, canonical variable name, scheme, and auth
 * yes/no only — never the URL, host, port, user, password, bypass entries, or
 * fingerprint.
 */
export function describeProviderProxy(policy: ProviderProxyPolicy, destination: URL): ProviderProxyDiagnostic {
  if (policy.kind === "explicit") {
    return {
      route: "proxy-configured",
      source: policy.source,
      variable: PROVIDER_PROXY_ENV_KEY,
      scheme: policy.secretUrl.scheme,
      authConfigured: policy.secretUrl.authConfigured,
    };
  }
  if (policy.kind === "direct") {
    return { route: "direct", source: "none" };
  }
  const secure = destination.protocol === "https:" || destination.protocol === "wss:";
  const candidate = secure ? policy.secure : policy.plain;
  if (!candidate) return { route: "direct", source: "none" };
  if (policy.noProxy && matchesNoProxy(policy.noProxy, destination.hostname)) {
    return {
      route: "bypassed",
      source: "process-standard",
      variable: candidate.variable,
      scheme: candidate.secretUrl.scheme,
      authConfigured: candidate.secretUrl.authConfigured,
    };
  }
  return {
    route: "proxy-configured",
    source: "process-standard",
    variable: candidate.variable,
    scheme: candidate.secretUrl.scheme,
    authConfigured: candidate.secretUrl.authConfigured,
  };
}

/** Human-readable one-line Doctor summary derived from a diagnostic. */
export function formatProviderProxyDiagnostic(diagnostic: ProviderProxyDiagnostic): string {
  const state = diagnostic.route === "proxy-configured"
    ? "configured"
    : diagnostic.route === "bypassed"
      ? "inherited (bypassed for selected endpoint)"
      : "direct (no configured route)";
  const source = diagnostic.source === "user-file"
    ? "user file"
    : diagnostic.source === "process-vesicle"
      ? "process"
      : diagnostic.source === "process-standard"
        ? `inherited (${diagnostic.variable ?? "env"})`
        : "no configured route";
  const detail = diagnostic.scheme
    ? `; ${diagnostic.scheme}; ${diagnostic.authConfigured ? "authentication configured" : "no authentication"}`
    : "";
  return `Provider proxy: ${state} (${source}${detail})`;
}
