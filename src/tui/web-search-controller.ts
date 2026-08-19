// /websearch — session override owner for the provider-native built-in web
// search toggle (#225 frozen design D1/D-C). Process-scoped like the theme
// preference controller: /new, a resume, or a provider/model switch falls
// back to the model entry's `webSearchDefault`, and the override never
// persists to session records.

import {
  clearSessionWebSearchOverride,
  effectiveWebSearchEnabled,
  readSessionWebSearchOverride,
  setSessionWebSearchOverride,
  webSearchSupported,
  type WebSearchConfigView,
} from "../core/agent-loop/web-search-state";

export type WebSearchControllerInputs = {
  /** Active session id, when a session exists. */
  getSessionId: () => string | undefined;
  /** Selected model entry's view of the two toggle-governing fields. */
  getModelView: () => WebSearchConfigView;
};

export type WebSearchController = {
  /** Whether the effective toggle is on right now. */
  enabled: () => boolean;
  /** True when the model entry declares the `builtinWebSearch` capability. */
  supported: () => boolean;
  /** Status line for `/websearch` with no arguments. */
  statusText: () => string;
  /**
   * Apply a session override. Returns a system notice to echo: the disclosure
   * when built-in search turns on, a warning when the model cannot use it,
   * or an explanation when there is no session to toggle yet.
   */
  applyOverride: (enabled: boolean) => string;
  /** Drop the override for the active session, if any. */
  clearOverride: () => void;
};

const DISCLOSURE = [
  "Built-in web search is ON for this session.",
  "Searches run on the provider side: your conversation-derived queries leave with the request, results may be injected server-side, and there is no per-call approval.",
  "Usage-based search billing applies per provider and cannot be counted exactly from the client.",
  "Turn it off anytime with /websearch off.",
].join(" ");

export function createWebSearchController(inputs: WebSearchControllerInputs): WebSearchController {
  return {
    enabled: () => {
      const sessionId = inputs.getSessionId();
      return sessionId !== undefined && effectiveWebSearchEnabled(inputs.getModelView(), sessionId);
    },
    supported: () => webSearchSupported(inputs.getModelView()),
    statusText: () => {
      const view = inputs.getModelView();
      if (!webSearchSupported(view)) {
        return "Built-in web search: the selected model does not declare the builtinWebSearch capability.";
      }
      const sessionId = inputs.getSessionId();
      if (sessionId === undefined) {
        return `Built-in web search: no active session yet (model default ${view.webSearchDefault === true ? "on" : "off"}); the toggle applies once a session starts.`;
      }
      const override = readSessionWebSearchOverride(sessionId);
      if (override !== undefined) {
        return `Built-in web search: ${override ? "on" : "off"} (session override; model default ${view.webSearchDefault === true ? "on" : "off"}).`;
      }
      return `Built-in web search: ${view.webSearchDefault === true ? "on" : "off"} (model default; /websearch on|off overrides for this session).`;
    },
    applyOverride: (enabled) => {
      if (!webSearchSupported(inputs.getModelView())) {
        return enabled
          ? "Built-in web search cannot be enabled: the selected model does not declare the builtinWebSearch capability, so no search would run."
          : "Built-in web search is already off for this model (no builtinWebSearch capability declared).";
      }
      const sessionId = inputs.getSessionId();
      if (sessionId === undefined) {
        return "No active session yet — start or resume a session before toggling built-in web search.";
      }
      setSessionWebSearchOverride(sessionId, enabled);
      return enabled ? DISCLOSURE : "Built-in web search is off for this session.";
    },
    clearOverride: () => {
      const sessionId = inputs.getSessionId();
      if (sessionId !== undefined) clearSessionWebSearchOverride(sessionId);
    },
  };
}
