import type { ProviderRetryInfo } from "./types";

/**
 * Render a transport retry as a compact, consistent label for status lines and
 * activity logs. The retry decision itself stays single-sourced in
 * `fetchProvider`; callers only use this to surface an already-decided retry.
 */
export function providerRetryLabel(info: ProviderRetryInfo): string {
  return `attempt ${info.attempt}/${info.maxRetries}${info.status ? ` · HTTP ${info.status}` : ""}`;
}
