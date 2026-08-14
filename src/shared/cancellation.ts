/**
 * Shared turn-cancellation primitives. Neutral to MCP, provider, and session
 * layers: any subsystem that honors a caller AbortSignal rethrows through
 * these so cancellations surface as the caller's own abort reason.
 */

/** The original abort reason, defaulting to a standard AbortError. */
export function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

/** Throws the signal's abort reason when the signal has been aborted. */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}
