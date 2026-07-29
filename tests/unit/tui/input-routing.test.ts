import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { KeyEvent } from "@opentui/core";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { consumeKey, createInputRouter, createRoutingKey, isClipboardImagePasteKey, type InputRoutingOptions } from "../../../src/tui/input-routing";
import { createWorkspaceController } from "../../../src/tui/workspace-controller";
import type { TuiKeyEvent } from "../../../src/tui/decision-interaction";

describe("TUI input routing", () => {
  test("preserves original OpenTUI event consumption through normalized key routing", () => {
    const rawKey = keyEvent("UP");

    const key = createRoutingKey(rawKey);
    consumeKey(key);

    expect(key.name).toBe("up");
    expect(rawKey.defaultPrevented).toBe(true);
    expect(rawKey.propagationStopped).toBe(true);
  });

  test("keeps OpenTUI prototype methods callable when they are not otherwise enumerable", () => {
    const rawKey = keyEvent("c", { ctrl: true });

    expect(Object.hasOwn(rawKey, "preventDefault")).toBe(false);
    expect(Object.hasOwn(rawKey, "stopPropagation")).toBe(false);

    consumeKey(createRoutingKey(rawKey));

    expect(rawKey.defaultPrevented).toBe(true);
    expect(rawKey.propagationStopped).toBe(true);
  });

  test.each([
    ["raw Ctrl+V control byte", keyEvent("v", { ctrl: true, sequence: "\x16", raw: "\x16" })],
    ["Ctrl+Alt+V", keyEvent("v", { ctrl: true, meta: true })],
    ["Alt+V", keyEvent("v", { meta: true })],
    ["Option+V", keyEvent("v", { option: true })],
  ])("recognizes %s as a clipboard-image paste key", (_label, rawKey) => {
    expect(isClipboardImagePasteKey(createRoutingKey(rawKey))).toBe(true);
  });

  test.each([
    ["plain v", keyEvent("v")],
    ["Ctrl+Shift+V text-paste shortcut", keyEvent("v", { ctrl: true, shift: true })],
    ["unrelated Ctrl key", keyEvent("x", { ctrl: true })],
  ])("does not treat %s as a clipboard-image paste key", (_label, rawKey) => {
    expect(isClipboardImagePasteKey(createRoutingKey(rawKey))).toBe(false);
  });
});

describe("TUI input routing: workspace image paste ownership (#134)", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "vesicle-routing-"));
    await mkdir(join(root, "workspace"), { recursive: true });
    await writeFile(join(root, "notes.txt"), "line one\n");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  // Builds routing options whose modal/picker accessors all resolve to null so
  // the bottom surface is "composer" and keys reach the workspace/composer
  // layer. pasteClipboardImage is a spy; the workspace controller is real.
  function buildRouter(workspace: ReturnType<typeof createWorkspaceController>) {
    let pastes = 0;
    const router = createInputRouter({
      renderer: {} as InputRoutingOptions["renderer"],
      setStatus: () => {},
      rewindPicker: () => null,
      handleRewindKey: () => false,
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
      handleQuestionKey: () => false,
      activeGateRequest: () => null,
      handleGateKey: () => false,
      pasteClipboardImage: async () => { pastes += 1; },
      handleComposerKey: () => true,
      handlePromptEscape: () => {},
      handleDecisionPaste: () => false,
      insertComposerPaste: () => {},
      workspaceActive: () => workspace.activePage() === "workspace",
      workspaceFocusRegion: workspace.focusRegion,
      handleWorkspaceKey: workspace.handleKey,
    });
    return { router, pasteCount: () => pastes };
  }

  test("workspace composer focus routes Ctrl+V and Alt/Option+V to pasteClipboardImage", async () => {
    const workspace = createWorkspaceController(root);
    await workspace.openWorkspaceTarget();
    const { router, pasteCount } = buildRouter(workspace);

    workspace.handleKey({ name: "escape" } as TuiKeyEvent); // tree -> composer
    expect(workspace.focusRegion()).toBe("composer");

    router.handleKey(keyEvent("v", { ctrl: true }));
    expect(pasteCount()).toBe(1);
    router.handleKey(keyEvent("v", { meta: true }));
    expect(pasteCount()).toBe(2);
    router.handleKey(keyEvent("v", { option: true }));
    expect(pasteCount()).toBe(3);
  });

  test("workspace tree focus swallows Ctrl+V without image paste", async () => {
    const workspace = createWorkspaceController(root);
    await workspace.openWorkspaceTarget();
    const { router, pasteCount } = buildRouter(workspace);

    expect(workspace.focusRegion()).toBe("tree");
    router.handleKey(keyEvent("v", { ctrl: true }));
    expect(pasteCount()).toBe(0);
  });

  test("workspace editor focus does not trigger image paste", async () => {
    const workspace = createWorkspaceController(root);
    await workspace.openWorkspaceTarget("notes.txt");
    const { router, pasteCount } = buildRouter(workspace);

    expect(workspace.focusRegion()).toBe("editor");
    router.handleKey(keyEvent("v", { ctrl: true }));
    expect(pasteCount()).toBe(0);
  });

  test("chat page (workspace inactive) still routes Ctrl+V to image paste", async () => {
    const workspace = createWorkspaceController(root);
    const { router, pasteCount } = buildRouter(workspace);

    expect(workspace.activePage()).toBe("chat");
    router.handleKey(keyEvent("v", { ctrl: true }));
    expect(pasteCount()).toBe(1);
  });
});

function keyEvent(name: string, modifiers: {
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  option?: boolean;
  sequence?: string;
  raw?: string;
} = {}): KeyEvent {
  return new KeyEvent({
    name,
    ctrl: modifiers.ctrl ?? false,
    meta: modifiers.meta ?? false,
    shift: modifiers.shift ?? false,
    option: modifiers.option ?? false,
    sequence: modifiers.sequence ?? "",
    number: false,
    raw: modifiers.raw ?? "",
    eventType: "press",
    source: "raw",
  });
}
