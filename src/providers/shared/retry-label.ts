import type { ProviderRetryInfo } from "./types";

/** Shared shape used by both the runtime callback and the `provider_retry` event. */
type RetryLabelInfo = Pick<ProviderRetryInfo, "attempt" | "maxRetries" | "status">;

/**
 * Status-line label for a transport retry. The retry decision itself stays
 * single-sourced in `fetchProvider`; callers only use this to surface an
 * already-decided retry.
 */
export function providerRetryLabel(info: RetryLabelInfo): string {
  return `attempt ${info.attempt}/${info.maxRetries}${info.status ? ` · HTTP ${info.status}` : ""}`;
}

/**
 * Activity-log label for a transport retry — a `prefix` such as "provider retry"
 * or "/init retry" followed by the attempt/status tail. Distinct from
 * `providerRetryLabel` (which uses the `· HTTP` status-line form) so the two
 * surfaces stay readable in their own contexts while sharing the tail format.
 */
export function providerRetryActivityLabel(prefix: string, info: RetryLabelInfo): string {
  return `${prefix} ${info.attempt}/${info.maxRetries}${info.status ? ` (${info.status})` : ""}`;
}
