import type { ModelCapabilities } from "../../config/env";

/**
 * Structural view of the model config the toggle depends on. `VesicleConfig`
 * satisfies this, and TUI-side callers can pass just the selected model
 * entry's view of the same two fields.
 */
export type WebSearchConfigView = {
  capabilities?: ModelCapabilities;
  webSearchDefault?: boolean;
};

// Session web-search toggle overrides are process-local by design (frozen
// design D-C, mirroring the theme preference controller): a resume or /new
// drops the override and the model-entry default takes over again. The toggle
// only gates the per-turn built-in search declaration; replayed history is
// unaffected, so losing the override carries no correctness risk.
const sessionWebSearchOverrides = new Map<string, boolean>();

/** Record the session-level `/websearch` override. */
export function setSessionWebSearchOverride(sessionId: string, enabled: boolean): void {
  sessionWebSearchOverrides.set(sessionId, enabled);
}

/** Drop the session override (new session, resume, or provider/model switch). */
export function clearSessionWebSearchOverride(sessionId: string): void {
  sessionWebSearchOverrides.delete(sessionId);
}

/** The session override, when one has been set in this process. */
export function readSessionWebSearchOverride(sessionId: string): boolean | undefined {
  return sessionWebSearchOverrides.get(sessionId);
}

/** True when the model entry declares the `builtinWebSearch` capability. */
export function webSearchSupported(config: WebSearchConfigView): boolean {
  return config.capabilities?.builtinWebSearch === true;
}

/**
 * Effective built-in web search state for a session: the session override if
 * set, otherwise the model entry's `webSearchDefault`, otherwise off. A model
 * that does not declare the `builtinWebSearch` capability is always off —
 * the preference alone never turns an unsupported model on.
 */
export function effectiveWebSearchEnabled(config: WebSearchConfigView, sessionId: string): boolean {
  if (!webSearchSupported(config)) return false;
  const override = sessionWebSearchOverrides.get(sessionId);
  if (override !== undefined) return override;
  return config.webSearchDefault === true;
}
