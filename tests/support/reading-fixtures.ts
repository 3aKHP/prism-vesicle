import type { BottomSurfaceMode, BottomSurfaceProps } from "../../src/tui/views/BottomSurface";
import type { ReadingSurfaceOptions } from "../../src/tui/reading/surfaces";
import type { RewindPoint } from "../../src/core/rewind/service";
import type { BranchTreeFork } from "../../src/core/branch/service";

export const longBody = Array.from({ length: 24 }, (_, i) => `READABLE-LINE-${i + 1}`).join("\n");
export const readingOptions: ReadingSurfaceOptions = {
  width: 80, height: 13, busy: false, childPermission: false,
  modelTitle: "Models", modelItems: [{ id: "m", label: "model-name-that-exceeds-label-column", detail: longBody }],
  skillTitle: "Skills", skillItems: [{ id: "s", label: "skill", detail: longBody }],
  qualityTitle: "Quality", qualityItems: [{ id: "q", label: "quality", detail: longBody }],
};

const common = { sessionId: "session", sessionPath: "session.jsonl", messages: [], assistantContent: "", engine: "etl" as const };
const judge = { providerAlias: "test", modelId: "judge", judgeTimeoutMs: 1000 };
const point: RewindPoint = {
  uuid: "u1", parentUuid: null, branchHeadUuid: null, content: longBody, timestamp: "2026-09-05T00:00:00Z",
  checkpointTainted: true, failedTurn: true,
  diffStats: { filesChanged: Array.from({ length: 20 }, (_, i) => `workspace/file-${i}.md`), insertions: 10, deletions: 5 },
};
const fork: BranchTreeFork = {
  forkRecordUuid: "u1", promptExcerpt: longBody, activePath: true,
  candidates: [{ rootUuid: "r1", endpointUuid: "e1", excerpt: longBody, ts: "2026-09-05T00:00:00Z", activePath: true, authoredTurnCount: 1, bundleStatus: "missing", tainted: true }],
};

export const readingModes: BottomSurfaceMode[] = [
  { kind: "permission", request: { id: "p1", sessionId: "session", toolCallId: "t1", toolName: "shell_exec", arguments: JSON.stringify({ command: longBody }), permissionClass: "arbitrary_exec", mode: "MOMENTUM", createdAt: "2026-09-05T00:00:00Z" } },
  { kind: "gate", gate: { gate: "blueprint", summary: longBody } },
  { kind: "question", pending: { ...common, kind: "needs_user_question", toolCallId: "question-1", question: { header: "Question", question: longBody, options: [
    ...Array.from({ length: 4 }, (_, i) => ({ label: `Choice ${i}`, description: `Description ${i}`, kind: "model" as const })),
    { label: "Skip", description: "Continue", kind: "skip" }, { label: "Answer freely", description: "Type", kind: "freeform" },
  ] } } },
  { kind: "quality", pending: { ...common, kind: "needs_quality_decision", decision: { id: "q1", reason: "exhausted", producer: "etl", findingCount: 24, canRetry: false, blockedReason: longBody, targets: [{ id: "a1", path: "workspace/story.md", findingIds: [] }] } } },
  { kind: "yolo", stage: 2 },
  { kind: "quality-rewrite-confirm", state: { stage: 2, focused: "confirm", candidate: judge } },
  { kind: "session-migration", state: { stage: 1, focused: "confirm", busy: false, target: { sessionId: "s1", preview: "preview", startedAt: "t", updatedAt: "t", recordCount: 4 }, report: {
    sessionId: "s1", engine: "etl", from: undefined, to: undefined, verdict: "warning",
    findings: Array.from({ length: 24 }, (_, i) => ({ severity: "warning" as const, layer: "resume" as const, message: `finding-${i}: ${"long compatibility detail ".repeat(5)}` })),
  } } },
  { kind: "rewind", picker: { points: [point], selected: 0, target: point, restoreSelected: 0, summaryFeedback: "keep this", summaryCursor: 4, busy: false } },
  { kind: "branch", picker: { forks: [fork], selected: 0, expanded: [fork.forkRecordUuid], busy: false, confirm: { kind: "switch", fork, candidate: fork.candidates[0], selected: 0, diffStats: point.diffStats } } },
  { kind: "session", picker: { selected: 0, sessions: [{ sessionId: "s1", preview: longBody, startedAt: "t", updatedAt: "t", recordCount: 4 }] } },
  { kind: "model", picker: { step: "model", providerId: "test", selected: 0 } },
  { kind: "skill-picker", picker: { selected: 0 } },
  { kind: "quality-picker", picker: { step: "model", selected: 0, candidate: judge, currentMode: "off" } },
];

export function readingPanelProps(mode: BottomSurfaceMode, width = 80, height = 14): BottomSurfaceProps {
  const props: BottomSurfaceProps = {
    layout: { width, height: 24, mode: "compact", showSidebar: false, leftPanelWidth: 24, bottomHeight: height, summaryLines: height - 6, footerHeight: 1 },
    yoloStage: null, migrationReview: null, permissionRequest: undefined, question: null, quality: null,
    gate: null, rewind: null, branch: null, session: null, skillPicker: null, qualityPicker: null, qualityRewriteConfirm: null, model: null,
    composerFocused: false, gateFocus: "confirm", gateFeedbackMode: null, gateFeedback: "", gateFeedbackCursor: 0,
    engineSwitchPending: false, questionSelected: 0, qualitySelected: 0, questionFreeformText: "", questionFreeformCursor: 0,
    readingAvailable: true, promptZone: "options",
    modelItems: readingOptions.modelItems, modelTitle: readingOptions.modelTitle,
    skillPickerItems: readingOptions.skillItems, skillPickerTitle: readingOptions.skillTitle,
    qualityPickerItems: readingOptions.qualityItems, qualityPickerTitle: readingOptions.qualityTitle,
    commandMenuOpen: false, commandItems: [], commandSelected: 0, commandArgumentMenuOpen: false, commandArgumentItems: [], commandArgumentSelected: 0,
    commandArgumentDraft: null, composerPopupMaxRows: 0, composerPopupOpen: false, inputNeedsExpandedBottom: false, inputValue: "", inputCursor: 0,
    inputWidth: width - 4, busy: false, queuedInputs: [], providerConfigReady: true,
  };
  switch (mode.kind) {
    case "yolo": props.yoloStage = mode.stage; break;
    case "session-migration": props.migrationReview = mode.state; break;
    case "permission": props.permissionRequest = mode.request; break;
    case "gate": props.gate = mode.gate; break;
    case "question": props.question = mode.pending; break;
    case "quality": props.quality = mode.pending; break;
    case "quality-rewrite-confirm": props.qualityRewriteConfirm = mode.state; break;
    case "rewind": props.rewind = mode.picker; break;
    case "branch": props.branch = mode.picker; break;
    case "session": props.session = mode.picker; break;
    case "model": props.model = mode.picker; break;
    case "skill-picker": props.skillPicker = mode.picker; break;
    case "quality-picker": props.qualityPicker = mode.picker; break;
    case "composer": break;
  }
  return props;
}
