import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import { createInputRouter, type InputRoutingOptions } from "../../../src/tui/input-routing";
import { MessageStream } from "../../../src/tui/views/MessageStream";
import type { TuiKeyEvent } from "../../../src/tui/decision-interaction";
import type { TurnAnchor } from "../../../src/tui/turn-anchors";

/**
 * Unified turn-focus cursor: Alt+↑/↓ navigates every transcript (not just
 * Stage sessions), wraps at the edges, and Alt+←/→ reports guidance instead
 * of dying silently when no candidate switcher is armed.
 */

const anchors: TurnAnchor[] = [
  { forkUuid: "u1", userMessageId: "u1", assistantMessageId: "a1", hasCandidates: false },
  { forkUuid: "u2", userMessageId: "u2", assistantMessageId: "a2", hasCandidates: true },
];

async function captureCursorHandler(props: {
  candidateSwitcher?: { index: number; total: number } | null;
  focusedTurn?: string | null;
}) {
  let handler: ((key: TuiKeyEvent) => boolean) | undefined;
  const focuses: string[] = [];
  const rejections: number[] = [];
  const switches: number[] = [];
  const [focused, setFocused] = createSignal(props.focusedTurn ?? null);
  const [switcher] = createSignal(props.candidateSwitcher ?? null);
  const [anchorSignal] = createSignal(anchors);
  const setup = await testRender(() => (
    <MessageStream
      messages={[
        { id: "u1", role: "user", content: "turn one" },
        { id: "a1", role: "assistant", content: "reply one" },
        { id: "u2", role: "user", content: "turn two" },
        { id: "a2", role: "assistant", content: "reply two" },
      ]}
      streamingReasoning=""
      streamingAssistant=""
      reasoningMode="collapsed"
      contentWidth={80}
      agents={[]}
      showHero={false}
      candidateSwitcher={switcher}
      onCandidateSwitch={(direction) => { switches.push(direction); }}
      onCandidateSwitchRejected={() => { rejections.push(1); }}
      turnAnchors={anchorSignal}
      focusedTurn={focused}
      onFocusTurn={(fork) => { focuses.push(fork); setFocused(fork); }}
      registerStageKeyHandler={(registered) => { handler = registered; }}
    />
  ), { width: 90, height: 24 });
  await setup.flush();
  if (!handler) throw new Error("MessageStream did not register a key handler");
  return {
    handler,
    focuses,
    rejections,
    switches,
    dispose: () => setup.renderer.destroy(),
  };
}

describe("tui: unified turn-focus cursor", () => {
  test("Alt+↓ steps through turns from the top and wraps around", async () => {
    const { handler, focuses, dispose } = await captureCursorHandler({});
    try {
      expect(handler({ name: "down", meta: true })).toBe(true);
      expect(handler({ name: "down", option: true })).toBe(true);
      expect(handler({ name: "down", option: true })).toBe(true); // wraps to u1
      expect(focuses).toEqual(["u1", "u2", "u1"]);
    } finally {
      dispose();
    }
  });

  test("Alt+↑ without focus lands on the last turn", async () => {
    const { handler, focuses, dispose } = await captureCursorHandler({});
    try {
      expect(handler({ name: "up", meta: true })).toBe(true);
      expect(focuses).toEqual(["u2"]);
    } finally {
      dispose();
    }
  });

  test("Alt+←/→ rejects with guidance when no switcher is armed, and switches when one is", async () => {
    const armed = await captureCursorHandler({ candidateSwitcher: { index: 0, total: 2 } });
    try {
      expect(armed.handler({ name: "left", option: true })).toBe(true);
      expect(armed.switches).toEqual([-1]);
      expect(armed.rejections).toEqual([]);
    } finally {
      armed.dispose();
    }

    const unarmed = await captureCursorHandler({});
    try {
      expect(unarmed.handler({ name: "left", option: true })).toBe(true);
      expect(unarmed.handler({ name: "right", meta: true })).toBe(true);
      expect(unarmed.rejections.length).toBe(2);
      expect(unarmed.switches).toEqual([]);
    } finally {
      unarmed.dispose();
    }
  });

  test("bare arrows still fall through to the composer", async () => {
    const { handler, focuses, dispose } = await captureCursorHandler({});
    try {
      expect(handler({ name: "down" })).toBe(false);
      expect(focuses).toEqual([]);
    } finally {
      dispose();
    }
  });
});

describe("tui: Alt+←/→ guidance on surfaces without MessageStream", () => {
  function routingOptions(overrides: Partial<InputRoutingOptions> = {}): InputRoutingOptions {
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

  test("Alt+left at the composer swallow reports guidance instead of dying silently", () => {
    let rejections = 0;
    const router = createInputRouter(routingOptions({
      onRejectedCandidateSwitch: () => { rejections += 1; },
    }));
    router.handleKey({ name: "left", meta: true } as TuiKeyEvent);
    router.handleKey({ name: "right", option: true } as TuiKeyEvent);
    expect(rejections).toBe(2);
  });

  test("bare arrows stay silent at the composer swallow", () => {
    let rejections = 0;
    const router = createInputRouter(routingOptions({
      onRejectedCandidateSwitch: () => { rejections += 1; },
    }));
    router.handleKey({ name: "left" } as TuiKeyEvent);
    expect(rejections).toBe(0);
  });
});
