// /websearch — session override owner for the provider-native built-in web
// search toggle (#225 frozen design D1/D-C). Process-scoped like the theme
// preference controller: /new or a resume falls back to the model entry's
// `webSearchDefault`, and the override never persists to session records.

import {
  clearSessionWebSearchOverride,
  effectiveWebSearchEnabled,
  readSessionWebSearchOverride,
  setSessionWebSearchOverride,
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
   * when built-in search turns on, a warning when the model cannot use it.
   */
  applyOverride: (enabled: boolean) => string;
  /** Drop the override (falls back to the model entry default). */
  clearOverride: () => void;
};

const DISCLOSURE = [
  "Built-in web search is ON for this session.",
  "Searches run on the provider side: your conversation-derived queries leave with the request, results may be injected server-side, and there is no per-call approval.",
  "Usage-based search billing applies per provider and cannot be counted exactly from the client.",
  "Turn it off anytime with /websearch off.",
].join(" ");

export function createWebSearchController(inputs: WebSearchControllerInputs): WebSearchController {
  const sessionId = () => inputs.getSessionId() ?? "";

  return {
    enabled: () => effectiveWebSearchEnabled(inputs.getModelView(), sessionId()),
    supported: () => inputs.getModelView().capabilities?.builtinWebSearch === true,
    statusText: () => {
      const view = inputs.getModelView();
      if (view.capabilities?.builtinWebSearch !== true) {
        return "Built-in web search: the selected model does not declare the builtinWebSearch capability.";
      }
      const override = readSessionWebSearchOverride(sessionId());
      if (override !== undefined) {
        return `Built-in web search: ${override ? "on" : "off"} (session override; model default ${view.webSearchDefault === true ? "on" : "off"}).`;
      }
      return `Built-in web search: ${view.webSearchDefault === true ? "on" : "off"} (model default; /websearch on|off overrides for this session).`;
    },
    applyOverride: (enabled) => {
      if (enabled && inputs.getModelView().capabilities?.builtinWebSearch !== true) {
        return "Built-in web search is on, but the selected model does not declare the builtinWebSearch capability — the toggle stays inert for this model.";
      }
      setSessionWebSearchOverride(sessionId(), enabled);
      return enabled ? DISCLOSURE : "Built-in web search is off for this session.";
    },
    clearOverride: () => clearSessionWebSearchOverride(sessionId()),
  };
}
