import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import { createInputRouter, type InputRoutingOptions } from "../../../src/tui/input-routing";
import { MessageStream } from "../../../src/tui/views/MessageStream";
import type { TuiKeyEvent } from "../../../src/tui/decision-interaction";
import { dispatchTerminalKey } from "../../support/tui/terminal-key";

/**
 * #88 regenerate trigger: Ctrl+R re-runs the last turn as a new candidate.
 * Candidate switching keeps Alt+←/→ and must accept Alt reported as either
 * `meta` (legacy terminals) or `option` (enhanced protocols).
 */

function minimalRoutingOptions(overrides: Partial<InputRoutingOptions> = {}): InputRoutingOptions {
  return {
    renderer: {} as InputRoutingOptions["renderer"],
    setStatus: () => {},
    rewindPicker: () => null,
    handleRewindKey: () => false,
    branchPicker: () => null,
    handleBranchKey: () => false,
    modelPicker: () => null,
    handleModelPickerKey: () => false,
    qualityPicker: () => null,
    handleQualityPickerKey: () => false,
    qualityRewriteConfirm: () => null,
    handleRewriteConfirmKey: () => false,
    sessionPicker: () => null,
    handleSessionPickerKey: () => false,
    skillPicker: () => null,
    handleSkillPickerKey: () => false,
    yoloConfirmStage: () => null,
    handleYoloKey: () => false,
    activePermissionRequest: () => undefined,
    pendingUserQuestion: () => null,
    activeGateRequest: () => null,
    handleGateKey: () => false,
    handleQuestionKey: () => false,
    pasteClipboardImage: async () => {},
    handleComposerKey: () => false,
    handlePromptEscape: () => {},
    handleDecisionPaste: () => false,
    insertComposerPaste: () => {},
    ...overrides,
  } as InputRoutingOptions;
}

describe("tui: Ctrl+R regenerate shortcut", () => {
  test.each([
    ["traditional VT", "\x12", {}],
    ["Kitty keyboard protocol", "\x1b[114;5u", { useKittyKeyboard: true }],
  ] as const)("dispatches regenerate from %s input and consumes the event", (_label, sequence, parserOptions) => {
    let regenerations = 0;
    const router = createInputRouter(minimalRoutingOptions({
      triggerRegenerate: () => { regenerations += 1; },
    }));

    const key = dispatchTerminalKey(router.handleKey, sequence, parserOptions);

    expect(regenerations).toBe(1);
    expect(key.defaultPrevented).toBe(true);
  });

  test("plain R and enhanced Ctrl+Shift+R do not trigger regenerate", () => {
    let regenerations = 0;
    const router = createInputRouter(minimalRoutingOptions({
      triggerRegenerate: () => { regenerations += 1; },
      handleComposerKey: () => true,
    }));

    dispatchTerminalKey(router.handleKey, "r");
    dispatchTerminalKey(router.handleKey, "\x1b[114;6u", { useKittyKeyboard: true });

    expect(regenerations).toBe(0);
  });

  test("leaves Ctrl+R with Workspace so file reload keeps its existing shortcut", () => {
    let regenerations = 0;
    let workspaceKeys = 0;
    const router = createInputRouter(minimalRoutingOptions({
      triggerRegenerate: () => { regenerations += 1; },
      workspaceActive: () => true,
      workspaceFocusRegion: () => "editor",
      handleWorkspaceKey: (key) => {
        if (key.ctrl && key.name === "r") workspaceKeys += 1;
        return true;
      },
    }));

    const key = dispatchTerminalKey(router.handleKey, "\x12");

    expect(workspaceKeys).toBe(1);
    expect(regenerations).toBe(0);
    expect(key.defaultPrevented).toBe(true);
  });
});

describe("tui: Alt candidate switching accepts meta and option", () => {
  async function captureStageKeyHandler(props: {
    candidateSwitcher?: { index: number; total: number };
    onCandidateSwitch?: (direction: -1 | 1) => void;
  }) {
    let handler: ((key: TuiKeyEvent) => boolean) | undefined;
    const [switcher] = createSignal(props.candidateSwitcher ?? null);
    const setup = await testRender(() => (
      <MessageStream
        messages={[{ role: "user", content: "turn one" }, { role: "assistant", content: "reply one" }]}
        streamingReasoning=""
        streamingAssistant=""
        reasoningMode="collapsed"
        contentWidth={80}
        agents={[]}
        showHero={false}
        candidateSwitcher={switcher}
        onCandidateSwitch={props.onCandidateSwitch}
        registerStageKeyHandler={(registered) => { handler = registered; }}
      />
    ), { width: 90, height: 24 });
    await setup.flush();
    if (!handler) throw new Error("MessageStream did not register a stage key handler");
    // Destroying the renderer runs MessageStream's onCleanup, which replaces
    // the registered handler with a noop — keep it alive until assertions ran.
    return { handler, dispose: () => setup.renderer.destroy() };
  }

  test("Alt+←/→ cycles candidates whether Alt arrives as option or meta", async () => {
    const directions: number[] = [];
    const { handler, dispose } = await captureStageKeyHandler({
      candidateSwitcher: { index: 0, total: 2 },
      onCandidateSwitch: (direction) => { directions.push(direction); },
    });

    try {
      // Enhanced-protocol terminals report Alt as `option`…
      expect(handler({ name: "left", option: true })).toBe(true);
      // …legacy terminals report it as `meta`.
      expect(handler({ name: "right", meta: true })).toBe(true);
      expect(directions).toEqual([-1, 1]);
      // Bare arrows keep falling through to the composer.
      expect(handler({ name: "left" })).toBe(false);
      expect(directions).toEqual([-1, 1]);
    } finally {
      dispose();
    }
  });

  test("the switcher hint advertises both shortcuts", async () => {
    const [switcher] = createSignal({ index: 1, total: 2 });
    const setup = await testRender(() => (
      <MessageStream
        messages={[{ role: "user", content: "turn one" }, { role: "assistant", content: "reply one" }]}
        streamingReasoning=""
        streamingAssistant=""
        reasoningMode="collapsed"
        contentWidth={80}
        agents={[]}
        showHero={false}
        candidateSwitcher={switcher}
      />
    ), { width: 90, height: 24 });
    await setup.flush();
    const frame = setup.captureCharFrame();
    setup.renderer.destroy();

    expect(frame).toContain("< 2/2 >");
    expect(frame).toContain("Ctrl+R regenerate");
  });
});
