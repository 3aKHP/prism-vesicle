import { describe, expect, test } from "bun:test";
import {
  pendingDecisionPromptLabel,
  pendingDecisionStripLine,
  resolveBottomSurfaceMode,
  type BottomSurfaceState,
  type ModelPickerState,
} from "../../../src/tui/views/BottomSurface";
import type { GateRequest } from "../../../src/core/gate/types";
import type { PermissionRequest } from "../../../src/core/permissions";

function baseState(overrides: Partial<BottomSurfaceState> = {}): BottomSurfaceState {
  return {
    yoloStage: null,
    migrationReview: null,
    permissionRequest: undefined,
    question: null,
    quality: null,
    gate: null,
    rewind: null,
    branch: null,
    session: null,
    skillPicker: null,
    qualityRewriteConfirm: null,
    qualityPicker: null,
    model: null,
    ...overrides,
  };
}

const permission: PermissionRequest = {
  id: "p",
  sessionId: "s",
  toolCallId: "t",
  toolName: "shell_exec",
  arguments: "ls",
  permissionClass: "arbitrary_exec",
  mode: "MOMENTUM",
  createdAt: "2026-07-31T00:00:00.000Z",
};
const gate: GateRequest = { gate: "request_confirmation", summary: "confirm" };
const modelPickerState: ModelPickerState = { step: "provider", providerId: null, selected: 0 };

describe("BottomSurface: Workspace decision-panel suppression (#268 item 3)", () => {
  test.each([
    ["permission", { permissionRequest: permission }],
    ["gate", { gate }],
    ["question", { question: { question: { prompt: "pick", choices: [] } } as never }],
    ["quality", { quality: { decision: { prompt: "rewrite", options: [] } } as never }],
  ])("a pending %s resolves to the composer while suppressed", (_label, overrides) => {
    expect(resolveBottomSurfaceMode(baseState({ ...overrides, suppressDecisionPanels: true })).kind).toBe("composer");
    // The unsuppressed resolution still sees the prompt — suppression changes
    // presentation, not existence.
    expect(resolveBottomSurfaceMode(baseState(overrides)).kind).not.toBe("composer");
  });

  test.each([
    ["model picker", { model: modelPickerState }],
    ["skill picker", { skillPicker: { selected: 0 } as never }],
    ["yolo confirm", { yoloStage: 1 as const }],
    ["quality rewrite confirm", { qualityRewriteConfirm: { stage: 1 as const, focused: "confirm" as const, candidate: { providerAlias: "a", modelId: "m", judgeTimeoutMs: 1 } } }],
  ])("the %s keeps its panel while decision panels are suppressed", (_label, overrides) => {
    expect(resolveBottomSurfaceMode(baseState({ ...overrides, suppressDecisionPanels: true })).kind).not.toBe("composer");
  });
});

describe("pendingDecisionPromptLabel", () => {
  test.each([
    ["permission", { permissionRequest: permission }, "Permission"],
    ["gate", { gate }, "Stop gate"],
    ["question", { question: { question: { prompt: "pick", choices: [] } } as never }, "Question"],
    ["quality", { quality: { decision: { prompt: "rewrite", options: [] } } as never }, "Quality decision"],
  ])("labels a pending %s", (_label, overrides, expected) => {
    expect(pendingDecisionPromptLabel(baseState(overrides))).toBe(expected);
  });

  test.each([
    ["quiet composer", {}],
    ["model picker", { model: modelPickerState }],
    ["yolo confirm outranking a gate", { yoloStage: 1 as const, gate }],
  ])("returns null for %s", (_label, overrides) => {
    expect(pendingDecisionPromptLabel(baseState(overrides))).toBeNull();
  });
});

describe("pendingDecisionStripLine", () => {
  test("carries the exact affordance so the strip stays discoverable", () => {
    expect(pendingDecisionStripLine("Permission", 80)).toBe("◆ Permission pending · Ctrl+O to answer");
  });

  test("truncates on narrow terminals instead of wrapping", () => {
    const line = pendingDecisionStripLine("Quality decision", 20);
    expect(line.startsWith("◆")).toBe(true);
    expect(line.endsWith("...")).toBe(true);
  });
});
