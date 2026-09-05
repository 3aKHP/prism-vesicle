import { describe, expect, test } from "bun:test";
import { createRoot } from "solid-js";
import { createDecisionController } from "../../../src/tui/decision-controller";
import { bodyReadAffordance, bodyScrollIndicator, bodyScrollWindow } from "../../../src/tui/format";
import type { TuiKeyEvent } from "../../../src/tui/decision-interaction";

function key(name: string, extras: Partial<TuiKeyEvent> = {}): TuiKeyEvent {
  return { name, ctrl: false, meta: false, shift: false, option: false, sequence: "", raw: "", ...extras } as TuiKeyEvent;
}

function printable(char: string): TuiKeyEvent {
  return key(char, { sequence: char });
}

describe("decision prompt note ownership", () => {
  function buildController() {
    let dispose!: () => void;
    const submits: string[] = [];
    const statuses: string[] = [];
    const built = createRoot((disposeRoot) => {
      dispose = disposeRoot;
      const controller = createDecisionController({
        busy: () => false,
        activeEngine: () => "etl" as never,
        permissionMode: () => "MOMENTUM" as never,
        setStatus: (value) => { if (typeof value === "string") statuses.push(value); },
        submitPermission: (resolution) => { submits.push(`permission:${JSON.stringify(resolution)}`); },
        submitChildPermission: () => { submits.push("child-permission"); },
        submitEngineSwitch: () => { submits.push("engine-switch"); },
        submitGate: () => { submits.push("gate"); },
        submitQuestionOption: (index) => { submits.push(`question-option:${index}`); },
        submitQuestionFreeform: (value) => { submits.push(`question-freeform:${String(value)}`); },
        submitQualityDecision: () => { submits.push("quality"); },
        applyPermissionMode: async () => undefined,
      });
      controller.setPendingGate({ kind: "needs_user", gate: { gate: "request_confirmation", summary: "s" }, engine: "etl" } as never);
      return controller;
    });
    return { ...built, dispose: () => dispose(), submits };
  }

  test("typing on the focused confirm option auto-arms its note and lands there", () => {
    const c = buildController();
    try {
      expect(c.gateFocus()).toBe("confirm");
      expect(c.handleGateKey(printable("h"))).toBe(true);
      expect(c.gateFeedbackMode()).toBe("confirm");
      expect(c.gateFeedback()).toBe("h");
      expect(c.handleGateKey(printable("i"))).toBe(true);
      expect(c.gateFeedback()).toBe("hi");
    } finally {
      c.dispose();
    }
  });

  test("paste auto-arms the confirm note the same way as typing", () => {
    const c = buildController();
    try {
      expect(c.handlePaste("note text")).toBe(true);
      expect(c.gateFeedbackMode()).toBe("confirm");
      expect(c.gateFeedback()).toBe("note text");
    } finally {
      c.dispose();
    }
  });

  test("typing on a permission confirm never arms an invisible note (allow drops it, later reject must not inherit it)", () => {
    const c = buildController();
    try {
      c.setPendingGate(null);
      c.setPendingPermission({
        kind: "needs_permission",
        sessionId: "s",
        sessionPath: "p",
        request: {
          id: "p1",
          sessionId: "s",
          toolCallId: "t",
          toolName: "shell_exec",
          arguments: "ls",
          permissionClass: "arbitrary_exec",
          mode: "MOMENTUM",
          createdAt: "2026-07-31T00:00:00.000Z",
        },
        remainingToolCalls: [],
        assistantContent: "",
        messages: [],
        engine: "etl",
      } as never);
      // Typing on Allow is swallowed: no note surface exists end to end.
      expect(c.handleGateKey(printable("please use utf8"))).toBe(false);
      expect(c.gateFeedbackMode()).toBeNull();
      expect(c.gateFeedback()).toBe("");
      // Paste on Allow is claimed and dropped, not armed.
      expect(c.handlePaste("pasted note")).toBe(true);
      expect(c.gateFeedbackMode()).toBeNull();
      expect(c.gateFeedback()).toBe("");
      // Allow submits with no feedback; moving to Reject cannot inherit any.
      expect(c.handleGateKey(key("enter"))).toBe(true);
      c.setGateFocus("reject");
      expect(c.handleGateKey(key("enter"))).toBe(true);
      const allow = JSON.parse(c.submits[0]!.slice("permission:".length));
      const reject = JSON.parse(c.submits[1]!.slice("permission:".length));
      expect(allow).toEqual({ decision: "allow_once", resolvedAt: allow.resolvedAt });
      expect(reject).toEqual({ decision: "reject", resolvedAt: reject.resolvedAt });
    } finally {
      c.dispose();
    }
  });

  test("reject typing keeps its always-live composer without arming a mode", () => {
    const c = buildController();
    try {
      c.setGateFocus("reject");
      expect(c.handleGateKey(printable("x"))).toBe(true);
      expect(c.gateFeedbackMode()).toBeNull();
      expect(c.gateFeedback()).toBe("x");
    } finally {
      c.dispose();
    }
  });

});

describe("decision prompt body zones: scroll window math", () => {
  test("clamps the offset to the real extent and reports folding", () => {
    expect(bodyScrollWindow(10, 4, -5)).toEqual({ start: 0, end: 4, folded: true });
    expect(bodyScrollWindow(10, 4, 100)).toEqual({ start: 6, end: 10, folded: true });
    expect(bodyScrollWindow(3, 4, 1)).toEqual({ start: 0, end: 3, folded: false });
  });

  test("the position indicator and the read affordance name their state", () => {
    expect(bodyScrollIndicator(4, 8, 30, 80)).toBe("▾ lines 5-8 of 30");
    expect(bodyReadAffordance(43, 80)).toBe("▸ 43 lines folded · Tab to read");
    expect(bodyReadAffordance(1, 80)).toBe("▸ 1 line folded · Tab to read");
  });
});
