import type { ModelCapabilities, ResponsesProfile, VesicleProvider } from "../../config/env";
import { providerAdmitsBuiltInWebSearch } from "../../providers/shared/web-search-support";
import type { EngineProfile } from "../engine/profile";

/**
 * Structural view of the model config the toggle depends on. `VesicleConfig`
 * satisfies this, and TUI-side callers can pass just the selected model
 * entry's view of the same two fields.
 */
export type WebSearchConfigView = {
  provider?: VesicleProvider;
  responsesProfile?: ResponsesProfile;
  capabilities?: ModelCapabilities;
  webSearchDefault?: boolean;
};

// Session web-search toggle overrides are process-local by design (frozen
// design D-C, mirroring the theme preference controller): a resume or /new
// drops the override and the model-entry default takes over again. The toggle
// gates the per-turn built-in search declaration, and adapters that admit
// built-in search also drop recorded search-call replay Items on
// declaration-off turns, so losing the override degrades to replaying the
// grounded answer text without the search records — no out-of-contract wire
// shape.
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

/** True when both the protocol/profile and model entry admit built-in search. */
export function webSearchSupported(config: WebSearchConfigView): boolean {
  return config.capabilities?.builtinWebSearch === true
    && providerAdmitsBuiltInWebSearch(config);
}

/** Built-in search is a model-visible tool and follows the Engine's declared surface. */
export function engineAllowsBuiltInWebSearch(profile: Pick<EngineProfile, "defaultTools">): boolean {
  return profile.defaultTools.includes("web_search");
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
