import { describe, expect, test } from "bun:test";
import type { QualityDecisionRequest } from "../../../src/core/quality";
import { qualityDecisionItems, qualityDecisionTitle } from "../../../src/tui/QualityDecisionPrompt";
import { sessionPickerLine } from "../../../src/tui/SessionPicker";
import { resolveBottomSurfaceMode } from "../../../src/tui/views/BottomSurface";
import { artifactSidebarLine } from "../../../src/tui/views/Sidebar";

const decision: QualityDecisionRequest = {
  id: "quality-warning-1",
  reason: "exhausted",
  producer: "runtime",
  findingCount: 2,
  targets: [{ id: "artifact:workspace/chapter.md", path: "workspace/chapter.md", findingIds: ["zh-a", "zh-b"] }],
  canRetry: true,
};

describe("TUI quality decision", () => {
  test("keeps quality ahead of question and gate surfaces", () => {
    const pending = {
      kind: "needs_quality_decision",
      sessionId: "session-quality",
      sessionPath: ".vesicle/sessions/session-quality.jsonl",
      engine: "runtime",
      decision,
      assistantContent: "",
      messages: [],
    } as import("../../../src/tui/decision-interaction").PendingQualityDecisionState;
    expect(resolveBottomSurfaceMode({
      yoloStage: null,
      permissionRequest: undefined,
      quality: pending,
      question: { question: { header: "Later" } } as any,
      gate: { gate: "runtime-turn", summary: "Later" },
      rewind: null,
      session: null,
      model: null,
    })).toEqual({ kind: "quality", pending });
  });

  test("shows the bounded target and three explicit outcomes", () => {
    expect(qualityDecisionTitle(decision, 80)).toContain("workspace/chapter.md");
    expect(qualityDecisionItems(decision).map((item) => item.id)).toEqual(["retry", "accept", "stop"]);
    expect(qualityDecisionItems({ ...decision, canRetry: false, blockedReason: "requires pack v1" })[0]).toMatchObject({
      label: "Revision unavailable",
      detail: "requires pack v1",
    });
  });

  test("marks quality sessions and warned artifacts without changing their numeric index", () => {
    expect(sessionPickerLine({
      sessionId: "2026-07-16-session-quality",
      startedAt: "2026-07-16T00:00:00.000Z",
      updatedAt: "2026-07-16T00:00:00.000Z",
      recordCount: 4,
      preview: "continue",
      pendingQuality: { state: "interrupted", producer: "runtime", findingCount: 1 },
    }, 0, true, 120)).toContain("[quality:interrupted]");
    expect(artifactSidebarLine("workspace/chapter.md", "workspace", 3, 40, true)).toBe("! 3. chapter.md");
  });
});
