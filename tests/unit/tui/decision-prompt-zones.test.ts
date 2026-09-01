import { describe, expect, test } from "bun:test";
import { createRoot } from "solid-js";
import { createDecisionController } from "../../../src/tui/decision-controller";
import { bodyScrollIndicator, bodyScrollWindow } from "../../../src/tui/format";
import type { TuiKeyEvent } from "../../../src/tui/decision-interaction";

function key(name: string, extras: Partial<TuiKeyEvent> = {}): TuiKeyEvent {
  return { name, ctrl: false, meta: false, shift: false, option: false, sequence: "", raw: "", ...extras } as TuiKeyEvent;
}

function printable(char: string): TuiKeyEvent {
  return key(char, { sequence: char });
}

describe("decision prompt body zones (#268 item 4): controller key routing", () => {
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
        submitPermission: () => { submits.push("permission"); },
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

  test("Tab enters the body zone; arrows scroll and clamp against the reported extent", () => {
    const c = buildController();
    try {
      expect(c.promptZone()).toBe("options");
      expect(c.handleGateKey(key("tab"))).toBe(true);
      expect(c.promptZone()).toBe("body");
      c.registerBodyExtent(50, 4);
      for (let i = 0; i < 3; i += 1) expect(c.handleGateKey(key("down"))).toBe(true);
      expect(c.bodyScrollOffset()).toBe(3);
      for (let i = 0; i < 60; i += 1) c.handleGateKey(key("down"));
      expect(c.bodyScrollOffset()).toBe(46);
      c.handleGateKey(key("home"));
      expect(c.bodyScrollOffset()).toBe(0);
      c.handleGateKey(key("end"));
      expect(c.bodyScrollOffset()).toBe(46);
    } finally {
      c.dispose();
    }
  });

  test("Enter never submits from the body zone; it and Esc return to the options zone", () => {
    const c = buildController();
    try {
      c.handleGateKey(key("tab"));
      c.registerBodyExtent(20, 4);
      c.handleGateKey(key("end"));
      const offsetBefore = c.bodyScrollOffset();
      expect(c.handleGateKey(key("enter"))).toBe(true);
      expect(c.submits).toEqual([]);
      expect(c.promptZone()).toBe("options");
      // The reading position survives the round trip while the prompt stays open.
      expect(c.bodyScrollOffset()).toBe(offsetBefore);
      c.handleGateKey(key("tab"));
      expect(c.handleGateKey(key("escape"))).toBe(true);
      expect(c.promptZone()).toBe("options");
      expect(c.submits).toEqual([]);
    } finally {
      c.dispose();
    }
  });

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

  test("a new prompt resets the zone and the scroll offset", () => {
    const c = buildController();
    try {
      c.handleGateKey(key("tab"));
      c.registerBodyExtent(50, 4);
      c.handleGateKey(key("end"));
      expect(c.promptZone()).toBe("body");
      c.setPendingGate(null);
      c.setPendingUserQuestion({
        kind: "needs_user_question",
        question: { header: "Scope", question: "Which?", options: [{ label: "A", description: "a", kind: "model" }] },
        engine: "etl",
      } as never);
      expect(c.promptZone()).toBe("options");
      expect(c.bodyScrollOffset()).toBe(0);
    } finally {
      c.dispose();
    }
  });

  test("Tab toggles the body zone from a question freeform composer too", () => {
    const c = buildController();
    try {
      c.setPendingGate(null);
      c.setPendingUserQuestion({
        kind: "needs_user_question",
        question: {
          header: "Scope",
          question: "Which?",
          options: [{ label: "Answer freely", description: "type", kind: "freeform" }],
        },
        engine: "etl",
      } as never);
      c.setQuestionSelected(0);
      expect(c.handleQuestionKey(printable("a"))).toBe(true);
      expect(c.questionFreeformText()).toBe("a");
      expect(c.handleQuestionKey(key("tab"))).toBe(true);
      expect(c.promptZone()).toBe("body");
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

  test("the position indicator names the visible slice", () => {
    expect(bodyScrollIndicator(4, 8, 30, 80)).toBe(" … lines 5-8 of 30");
  });
});
