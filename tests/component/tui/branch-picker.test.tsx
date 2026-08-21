import { describe, expect, test } from "bun:test";
import { testRender } from "@3akhp/opentui-solid";
import { createInputRouter, type InputRoutingOptions } from "../../../src/tui/input-routing";
import { BranchPicker } from "../../../src/tui/BranchPicker";
import type { BranchPickerState } from "../../../src/tui/branch/controller";
import { dispatchTerminalKey } from "../../support/tui/terminal-key";

/**
 * Any-depth candidate switching entry points: Ctrl+B opens the branch panel
 * from both terminal protocol flavours, and the panel renders the full tree
 * within 80 columns including the confirm-step file warnings.
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

describe("tui: Ctrl+B branch shortcut", () => {
  test.each([
    ["traditional VT", "\x02", {}],
    ["Kitty keyboard protocol", "\x1b[98;5u", { useKittyKeyboard: true }],
  ] as const)("dispatches the branch panel from %s input and consumes the event", (_label, sequence, parserOptions) => {
    let opened = 0;
    const router = createInputRouter(minimalRoutingOptions({
      triggerBranch: () => { opened += 1; },
    }));

    const key = dispatchTerminalKey(router.handleKey, sequence, parserOptions);

    expect(opened).toBe(1);
    expect(key.defaultPrevented).toBe(true);
  });

  test("Ctrl+B works on the Workspace page too", () => {
    let opened = 0;
    let workspaceKeys = 0;
    const router = createInputRouter(minimalRoutingOptions({
      triggerBranch: () => { opened += 1; },
      workspaceActive: () => true,
      workspaceFocusRegion: () => "tree",
      handleWorkspaceKey: () => {
        workspaceKeys += 1;
        return true;
      },
    }));

    dispatchTerminalKey(router.handleKey, "\x02");

    expect(opened).toBe(1);
    expect(workspaceKeys).toBe(0);
  });

  test("an open branch panel keeps its keys before the global trigger", () => {
    let opened = 0;
    let panelKeys = 0;
    const router = createInputRouter(minimalRoutingOptions({
      branchPicker: () => ({ forks: [], selected: 0, expanded: [], busy: false }) as BranchPickerState,
      handleBranchKey: () => {
        panelKeys += 1;
        return true;
      },
      triggerBranch: () => { opened += 1; },
    }));

    dispatchTerminalKey(router.handleKey, "\x02");

    expect(panelKeys).toBe(1);
    expect(opened).toBe(0);
  });
});

function treeState(overrides: Partial<BranchPickerState> = {}): BranchPickerState {
  return {
    forks: [
      {
        forkRecordUuid: "u1",
        promptExcerpt: "outline proposal",
        activePath: true,
        candidates: [
          {
            rootUuid: "a",
            endpointUuid: "a",
            excerpt: "three-act structure",
            ts: "2026-01-01T00:00:00.000Z",
            activePath: false,
            authoredTurnCount: 0,
            bundleStatus: "bundled",
            tainted: false,
          },
          {
            rootUuid: "b",
            endpointUuid: "b",
            excerpt: "dual-line narrative",
            ts: "2026-01-01T00:01:00.000Z",
            activePath: true,
            authoredTurnCount: 0,
            bundleStatus: "missing",
            tainted: false,
          },
        ],
      },
    ],
    selected: 1,
    expanded: ["u1"],
    busy: false,
    ...overrides,
  };
}

describe("BranchPicker rendering", () => {
  test("renders the tree rows with markers, hints, and the key legend at 80 columns", async () => {
    const setup = await testRender(() => (
      <box width={80} height={14}>
        <BranchPicker state={treeState()} width={80} />
      </box>
    ), { width: 80, height: 14 });
    await setup.flush();
    const frame = setup.captureCharFrame();
    setup.renderer.destroy();

    expect(frame).toContain("Candidate tree");
    expect(frame).toContain("outline proposal");
    expect(frame).toContain("2 candidates");
    expect(frame).toContain("three-act structure");
    expect(frame).toContain("files");
    expect(frame).toContain("no file state");
    expect(frame).toContain("Esc close");
  });

  test("the confirm step shows the file diff and the no-file-state warning", async () => {
    const state = treeState({
      confirm: {
        kind: "switch",
        fork: { forkRecordUuid: "u1", promptExcerpt: "outline proposal", activePath: true, candidates: [] },
        candidate: {
          rootUuid: "a",
          endpointUuid: "a",
          excerpt: "three-act structure",
          ts: "2026-01-01T00:00:00.000Z",
          activePath: false,
          authoredTurnCount: 0,
          bundleStatus: "missing",
          tainted: false,
        },
        selected: 0,
        diffStats: { filesChanged: ["workspace/outline.md", "workspace/notes.md"], insertions: 12, deletions: 3 },
      },
    });
    const setup = await testRender(() => (
      <box width={80} height={14}>
        <BranchPicker state={state} width={80} />
      </box>
    ), { width: 80, height: 14 });
    await setup.flush();
    const frame = setup.captureCharFrame();
    setup.renderer.destroy();

    expect(frame).toContain("Switch to candidate");
    expect(frame).toContain("2 changes +12 -3");
    expect(frame).toContain("No saved file state");
  });
});
