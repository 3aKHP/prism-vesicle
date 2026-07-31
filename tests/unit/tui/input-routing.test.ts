import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { InternalKeyHandler, KeyEvent } from "@opentui/core";
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

describe("TUI input routing: workspace paste ownership", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "vesicle-routing-"));
    await mkdir(join(root, "workspace"), { recursive: true });
    await writeFile(join(root, "notes.txt"), "line one\n");
    await writeFile(join(root, "data.bin"), Buffer.from([0x00, 0x01, 0x02, 0xff]));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function buildRouter(
    workspace: ReturnType<typeof createWorkspaceController>,
    overrides: Partial<InputRoutingOptions> = {},
  ) {
    let imagePastes = 0;
    const textPastes: string[] = [];
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
      pasteClipboardImage: async () => { imagePastes += 1; },
      handleComposerKey: () => true,
      handlePromptEscape: () => {},
      handleDecisionPaste: () => false,
      insertComposerPaste: (text) => { textPastes.push(text); },
      workspaceActive: () => workspace.activePage() === "workspace",
      workspaceFocusRegion: workspace.focusRegion,
      workspaceEditableSourcePasteActive: workspace.editableSourcePasteActive,
      handleWorkspaceKey: workspace.handleKey,
      ...overrides,
    });
    return { router, imagePasteCount: () => imagePastes, textPastes };
  }

  function pasteEvent(text: string) {
    let prevented = 0;
    const event = {
      bytes: new TextEncoder().encode(text),
      preventDefault: () => { prevented += 1; },
    };
    return { event, preventCount: () => prevented };
  }

  test("workspace composer focus routes Ctrl+V and Alt/Option+V to pasteClipboardImage", async () => {
    const workspace = createWorkspaceController(root);
    await workspace.openWorkspaceTarget();
    const { router, imagePasteCount } = buildRouter(workspace);

    workspace.handleKey({ name: "escape" } as TuiKeyEvent); // tree -> composer
    expect(workspace.focusRegion()).toBe("composer");

    router.handleKey(keyEvent("v", { ctrl: true }));
    expect(imagePasteCount()).toBe(1);
    router.handleKey(keyEvent("v", { meta: true }));
    expect(imagePasteCount()).toBe(2);
    router.handleKey(keyEvent("v", { option: true }));
    expect(imagePasteCount()).toBe(3);
  });

  test("workspace tree focus swallows Ctrl+V without image paste", async () => {
    const workspace = createWorkspaceController(root);
    await workspace.openWorkspaceTarget();
    const { router, imagePasteCount } = buildRouter(workspace);

    expect(workspace.focusRegion()).toBe("tree");
    router.handleKey(keyEvent("v", { ctrl: true }));
    expect(imagePasteCount()).toBe(0);
  });

  test("workspace editor focus does not trigger image paste", async () => {
    const workspace = createWorkspaceController(root);
    await workspace.openWorkspaceTarget("notes.txt");
    const { router, imagePasteCount } = buildRouter(workspace);

    expect(workspace.focusRegion()).toBe("editor");
    router.handleKey(keyEvent("v", { ctrl: true }));
    expect(imagePasteCount()).toBe(0);
  });

  test("chat page (workspace inactive) still routes Ctrl+V to image paste", async () => {
    const workspace = createWorkspaceController(root);
    const { router, imagePasteCount } = buildRouter(workspace);

    expect(workspace.activePage()).toBe("chat");
    router.handleKey(keyEvent("v", { ctrl: true }));
    expect(imagePasteCount()).toBe(1);
  });

  test("editable editor focus leaves paste unconsumed for the native textarea", async () => {
    const workspace = createWorkspaceController(root);
    await workspace.openWorkspaceTarget("notes.txt");
    const { router, textPastes } = buildRouter(workspace);

    expect(workspace.focusRegion()).toBe("editor");
    expect(workspace.isEditing()).toBe(true);

    const { event, preventCount } = pasteEvent("PASTE-LINE-1\nPASTE-LINE-2");
    router.handlePaste(event);

    expect(textPastes).toEqual([]);
    expect(preventCount()).toBe(0);
  });

  test("tree focus blocks paste without touching the composer", async () => {
    const workspace = createWorkspaceController(root);
    await workspace.openWorkspaceTarget();
    const { router, textPastes } = buildRouter(workspace);

    expect(workspace.focusRegion()).toBe("tree");

    const { event, preventCount } = pasteEvent("stray text");
    router.handlePaste(event);

    expect(textPastes).toEqual([]);
    expect(preventCount()).toBe(1);
  });

  test("non-editable viewer focus blocks paste without touching the composer", async () => {
    const workspace = createWorkspaceController(root);
    await workspace.openWorkspaceTarget("data.bin");
    const { router, textPastes } = buildRouter(workspace);

    expect(workspace.focusRegion()).toBe("editor");
    expect(workspace.isEditing()).toBe(false);

    const { event, preventCount } = pasteEvent("stray text");
    router.handlePaste(event);

    expect(textPastes).toEqual([]);
    expect(preventCount()).toBe(1);
  });

  test("missing Workspace focus data fails closed", async () => {
    const workspace = createWorkspaceController(root);
    await workspace.openWorkspaceTarget("notes.txt");
    const { router, textPastes } = buildRouter(workspace, {
      workspaceFocusRegion: undefined,
    });

    const { event, preventCount } = pasteEvent("stray text");
    router.handlePaste(event);

    expect(textPastes).toEqual([]);
    expect(preventCount()).toBe(1);
  });

  test("workspace composer focus inserts paste text exactly once and consumes the event", async () => {
    const workspace = createWorkspaceController(root);
    await workspace.openWorkspaceTarget();
    const { router, textPastes } = buildRouter(workspace);

    workspace.handleKey({ name: "escape" } as TuiKeyEvent); // tree -> composer
    expect(workspace.focusRegion()).toBe("composer");

    const { event, preventCount } = pasteEvent("multi\nline paste");
    router.handlePaste(event);

    expect(textPastes).toEqual(["multi\nline paste"]);
    expect(preventCount()).toBe(1);
  });

  test("chat page inserts paste text exactly once and consumes the event", async () => {
    const workspace = createWorkspaceController(root);
    const { router, textPastes } = buildRouter(workspace);

    expect(workspace.activePage()).toBe("chat");

    const { event, preventCount } = pasteEvent("chat paste");
    router.handlePaste(event);

    expect(textPastes).toEqual(["chat paste"]);
    expect(preventCount()).toBe(1);
  });

  test("non-composer bottom surface outranks the editable editor", async () => {
    const workspace = createWorkspaceController(root);
    await workspace.openWorkspaceTarget("notes.txt");
    const { router, textPastes } = buildRouter(workspace, {
      yoloConfirmStage: () => 1,
    });

    expect(workspace.isEditing()).toBe(true);

    const { event, preventCount } = pasteEvent("modal text");
    router.handlePaste(event);

    expect(textPastes).toEqual([]);
    expect(preventCount()).toBe(1);
  });

  test("workspace-local panel blocks paste from the covered editor", async () => {
    const workspace = createWorkspaceController(root);
    await workspace.openWorkspaceTarget("notes.txt");
    const { router, textPastes } = buildRouter(workspace);

    workspace.handleKey({ name: "p", ctrl: true } as TuiKeyEvent);
    expect(workspace.quickOpenActive()).toBe(true);
    expect(workspace.isEditing()).toBe(true);
    expect(workspace.editableSourcePasteActive()).toBe(false);

    const { event, preventCount } = pasteEvent("hidden editor text");
    router.handlePaste(event);

    expect(textPastes).toEqual([]);
    expect(preventCount()).toBe(1);
  });

  test("side-question overlay blocks paste before Workspace or composer routing", async () => {
    const workspace = createWorkspaceController(root);
    await workspace.openWorkspaceTarget("notes.txt");
    const { router, textPastes } = buildRouter(workspace, {
      sideQuestionOverlay: () => ({ kind: "answer" }),
    });

    const { event, preventCount } = pasteEvent("overlay text");
    router.handlePaste(event);

    expect(textPastes).toEqual([]);
    expect(preventCount()).toBe(1);
  });

  test("OpenTUI dispatch delivers unconsumed paste to the internal handler only for the editable editor", async () => {
    const workspace = createWorkspaceController(root);
    await workspace.openWorkspaceTarget("notes.txt");
    const { router, textPastes } = buildRouter(workspace);

    const keys = new InternalKeyHandler();
    let internal = 0;
    keys.on("paste", router.handlePaste);
    keys.onInternal("paste", () => { internal += 1; });

    keys.processPaste(new TextEncoder().encode("editor text"));
    expect(internal).toBe(1);
    expect(textPastes).toEqual([]);

    // Composer focus: the global handler consumes the event, internal never fires.
    workspace.cycleFocus(1); // editor -> composer
    expect(workspace.focusRegion()).toBe("composer");
    keys.processPaste(new TextEncoder().encode("composer text"));
    expect(internal).toBe(1);
    expect(textPastes).toEqual(["composer text"]);
  });
});

describe("TUI input routing: modal ownership of Esc", () => {
  type EscRecorder = { keys: string[] };
  type ModalCase = {
    label: string;
    overrides: (recorder: EscRecorder) => Partial<InputRoutingOptions>;
  };
  const owned: ModalCase[] = [
    {
      label: "YOLO confirm",
      overrides: (recorder) => ({
        yoloConfirmStage: () => 1,
        handleYoloKey: (key) => { recorder.keys.push(key.name ?? ""); return true; },
      }),
    },
    {
      label: "permission request",
      overrides: (recorder) => ({
        activePermissionRequest: () => ({ id: "p", sessionId: "s", toolCallId: "t", toolName: "shell_exec", arguments: "ls", permissionClass: "arbitrary_exec", mode: "MOMENTUM", createdAt: "2026-07-31T00:00:00.000Z" }),
        handleGateKey: (key) => { recorder.keys.push(key.name ?? ""); return true; },
      }),
    },
    {
      label: "gate request",
      overrides: (recorder) => ({
        activeGateRequest: () => ({ gate: "request_confirmation", summary: "confirm" }),
        handleGateKey: (key) => { recorder.keys.push(key.name ?? ""); return true; },
      }),
    },
    {
      label: "user question",
      overrides: (recorder) => ({
        pendingUserQuestion: () => ({ question: { prompt: "pick", choices: [{ label: "a", decision: "reject" }] } }) as never,
        handleQuestionKey: (key) => { recorder.keys.push(key.name ?? ""); return true; },
      }),
    },
    {
      label: "quality decision",
      overrides: (recorder) => ({
        pendingQualityDecision: () => ({ decision: { prompt: "rewrite", options: [{ label: "a", decision: "confirm" }] } }) as never,
        handleQualityKey: (key) => { recorder.keys.push(key.name ?? ""); return true; },
      }),
    },
    {
      label: "rewind picker",
      overrides: (recorder) => ({
        rewindPicker: () => ({}) as never,
        handleRewindKey: (key) => { recorder.keys.push(key.name ?? ""); return true; },
      }),
    },
    {
      label: "session picker",
      overrides: (recorder) => ({
        sessionPicker: () => ({}) as never,
        handleSessionPickerKey: (key) => { recorder.keys.push(key.name ?? ""); return true; },
      }),
    },
    {
      label: "skill picker",
      overrides: (recorder) => ({
        skillPicker: () => ({}) as never,
        handleSkillPickerKey: (key) => { recorder.keys.push(key.name ?? ""); return true; },
      }),
    },
    {
      label: "model picker",
      overrides: (recorder) => ({
        modelPicker: () => ({}) as never,
        handleModelPickerKey: (key) => { recorder.keys.push(key.name ?? ""); return true; },
      }),
    },
    {
      label: "quality picker",
      overrides: (recorder) => ({
        qualityPicker: () => ({}) as never,
        handleQualityPickerKey: (key) => { recorder.keys.push(key.name ?? ""); return true; },
      }),
    },
    {
      label: "quality rewrite confirm",
      overrides: (recorder) => ({
        qualityRewriteConfirm: () => ({}) as never,
        handleRewriteConfirmKey: (key) => { recorder.keys.push(key.name ?? ""); return true; },
      }),
    },
  ];

  function modalRouter(overrides: Partial<InputRoutingOptions>) {
    let promptEscapes = 0;
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
      pasteClipboardImage: async () => undefined,
      handleComposerKey: () => false,
      handlePromptEscape: () => { promptEscapes += 1; },
      handleDecisionPaste: () => false,
      insertComposerPaste: () => undefined,
      ...overrides,
    });
    return { router, promptEscapeCount: () => promptEscapes };
  }

  for (const modal of owned) {
    test(`prompt-level Esc is not called while the ${modal.label} surface owns the key`, () => {
      const recorder: EscRecorder = { keys: [] };
      const { router, promptEscapeCount } = modalRouter(modal.overrides(recorder));
      router.handleKey(keyEvent("escape"));
      expect(promptEscapeCount()).toBe(0);
      expect(recorder.keys).toEqual(["escape"]);
    });
  }

  test("an owning surface that declines the key still prevents prompt-level Esc", () => {
    const recorder: EscRecorder = { keys: [] };
    const { router, promptEscapeCount } = modalRouter({
      yoloConfirmStage: () => 1,
      handleYoloKey: (key) => { recorder.keys.push(key.name ?? ""); return false; },
    });
    router.handleKey(keyEvent("escape"));
    expect(promptEscapeCount()).toBe(0);
    expect(recorder.keys).toEqual(["escape"]);
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
