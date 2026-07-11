import type { ToolCall, ToolDefinition } from "../tools";

/**
 * Identifier for a declared stop gate, matching the stopGates list in an
 * engine profile YAML. The agent loop refuses gates the active engine did
 * not declare, so a prompt cannot invent new gates the host never approved.
 */
export type GateId = string;

/**
 * Body of a request_confirmation tool call. The model fills `summary` with
 * a compact human-readable rendering of what it wants confirmed (for ETL
 * Phase 0: Target Concept, Archetype, Core Desire, Topology Notes). The
 * host renders this verbatim above the gate options.
 *
 * `options` is optional: when omitted the host renders the default
 * Confirm/Reject pair. When provided, the model may narrow the
 * choices to engine-specific labels (still paired with the standard
 * decisions so the host semantics stay stable).
 */
export type GateRequest = {
  gate: GateId;
  summary: string;
  options?: GateOption[];
};

/**
 * A model-suggested option label. The `decision` field maps the label back
 * to one of the canonical decisions the host knows how to act on, so the
 * model can phrase options naturally without the host having to parse
 * free text for intent.
 */
export type GateOption = {
  label: string;
  decision: GateDecisionKind;
  hint?: string;
};

/**
 * The canonical decisions a gate can resolve to. Every gate UI offers these
 * two semantics regardless of how the option labels are phrased:
 *
 * - `confirm`  — proceed past the gate (advance to the next phase).
 * - `reject`   — do not proceed yet. Optional feedback may ask for changes,
 *                discussion, or clarification; an empty rejection is valid
 *                and should make the model ask what to change next.
 */
export type GateDecisionKind = "confirm" | "reject";

/**
 * A user's resolution of a gate. `feedback` is present when the user adds a
 * note; empty `reject` is still a valid resolution and asks the model to
 * clarify or discuss before retrying.
 */
export type GateResolution = {
  decision: GateDecisionKind;
  feedback?: string;
};

/**
 * Recognise a tool call as a request_confirmation invocation. Returns the
 * parsed GateRequest, or null if the call is not a gate request. Parsing
 * errors throw — a malformed gate call is a model contract violation the
 * user should see, not silently dropped.
 */
export function parseGateRequest(call: ToolCall): GateRequest {
  if (call.name !== "request_confirmation") {
    throw new Error(`parseGateRequest called on non-gate tool: ${call.name}`);
  }
  const args = JSON.parse(call.arguments || "{}") as Partial<GateRequest>;
  if (typeof args.gate !== "string" || args.gate.trim() === "") {
    throw new Error("request_confirmation requires a non-empty `gate` string.");
  }
  if (typeof args.summary !== "string" || args.summary.trim() === "") {
    throw new Error("request_confirmation requires a non-empty `summary` string.");
  }
  const options = Array.isArray(args.options) ? args.options : undefined;
  if (options) {
    for (const option of options) {
      if (typeof option?.label !== "string" || typeof option?.decision !== "string") {
        throw new Error("request_confirmation option requires `label` and `decision`.");
      }
      const decision = normalizeGateDecision(option.decision);
      if (!decision) {
        throw new Error(
          `request_confirmation option.decision must be confirm|reject, got "${option.decision}".`,
        );
      }
      option.decision = decision;
    }
  }
  return {
    gate: args.gate,
    summary: args.summary,
    options: options as GateOption[] | undefined,
  };
}

/**
 * The request_confirmation tool definition surfaced to the model. Tools are
 * only attached when the active engine profile declares at least one
 * stopGate — an engine with an empty stopGates list never offers this tool,
 * so its model cannot invoke a gate the host would then have to reject.
 */
export const gateToolDefinition: ToolDefinition = {
  type: "function",
  function: {
    name: "request_confirmation",
    description:
      "Pause the workflow and ask the user to confirm or reject the current blueprint, plan, or phase artifact before proceeding. Rejection may include change requests or discussion; empty rejection is valid and means the model should ask what to change. Only call this when the active engine prompt instructs a stop gate (e.g. ETL blueprint-confirmation or phase-confirmation). Do not call it for ordinary conversation.",
    parameters: {
      type: "object",
      properties: {
        gate: {
          type: "string",
          description:
            "The stop gate identifier declared by the active engine profile (e.g. \"blueprint-confirmation\"). Must match a gate the engine declared.",
        },
        summary: {
          type: "string",
          description:
            "Compact human-readable summary of what is being confirmed. Rendered verbatim above the gate options. For ETL: include the current blueprint or phase artifact, written file paths when applicable, and the proposed next phase.",
        },
        options: {
          type: "array",
          description:
            "Optional custom option labels. When omitted the host shows the standard Confirm/Reject pair. Each option carries a canonical decision the host knows how to act on.",
          items: {
            type: "object",
            properties: {
              label: { type: "string" },
              decision: { type: "string", enum: ["confirm", "reject"] },
              hint: { type: "string" },
            },
            required: ["label", "decision"],
            additionalProperties: false,
          },
        },
      },
      required: ["gate", "summary"],
      additionalProperties: false,
    },
  },
};

function normalizeGateDecision(value: string): GateDecisionKind | null {
  if (value === "confirm" || value === "reject") return value;
  // Compatibility for old prompts or in-flight sessions from before the
  // non-confirm paths were collapsed into a single rejection decision.
  if (value === "revise" || value === "chat") return "reject";
  return null;
}
