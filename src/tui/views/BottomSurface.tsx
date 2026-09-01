import { ThemedText } from "../theme-text";
import { For, Match, Switch } from "solid-js";
import type { GateRequest } from "../../core/gate/types";
import type { PermissionRequest } from "../../core/permissions";
import type { ExperimentalQualityMode } from "../../config/quality";
import type { ResponsiveTuiLayout } from "../layout";
import type { CommandArgumentCompletion } from "../commands/types";
import type { Command } from "../commands/types";
import { commandArgumentHint } from "../commands/options";
import type { GateFocusTarget } from "../GatePrompt";
import { GatePrompt, gateComposerIsActive, gateSummaryLineBudget, type PromptZone } from "../GatePrompt";
import { PermissionPrompt } from "../PermissionPrompt";
import { PromptComposer } from "../PromptComposer";
import { QualityRewritePrompt } from "../QualityRewritePrompt";
import { QuestionPrompt } from "../QuestionPrompt";
import { RewindPicker } from "../RewindPicker";
import { BranchPicker } from "../BranchPicker";
import { SessionPicker } from "../SessionPicker";
import { YoloPrompt } from "../YoloPrompt";
import { MigrationPrompt } from "../MigrationPrompt";
import type { MigrationReviewState } from "../session-migration-controller";
import type { PendingUserQuestionState } from "../decision-interaction";
import type { PendingQualityDecisionState } from "../decision-interaction";
import { QualityDecisionPrompt } from "../QualityDecisionPrompt";
import { palette } from "../theme";
import type { OptionItem, RewindPickerState, SessionPickerState } from "../types";
import type { BranchPickerState } from "../branch/controller";
import type { SkillPickerState } from "../skill-picker-controller";
import { queuedInputText, type QueuedInput } from "../input-queue";
import { truncateLine } from "../format";
import { ArgumentMenu } from "../widgets/ArgumentMenu";
import { CommandMenu } from "../widgets/CommandMenu";
import { OptionPicker } from "../widgets/OptionPicker";

export type ModelPickerState = {
  step: "provider" | "model";
  providerId: string | null;
  selected: number;
};

export type QualityPickerCandidate = {
  providerAlias: string;
  modelId: string;
  judgeTimeoutMs: number;
};

export type QualityPickerState = {
  step: "mode" | "provider" | "model";
  selected: number;
  candidate: QualityPickerCandidate;
  currentMode: ExperimentalQualityMode;
  currentTuple?: QualityPickerCandidate;
  browsingProvider?: string;
  // True when a retained profile exists but cannot be enabled (no longer
  // resolves or lacks its key). While true, observe/rewrite route to Change
  // Judge instead of silently substituting the active model (plan rule 3).
  requireChangeJudge?: boolean;
};

export type QualityRewriteConfirmState = {
  stage: 1 | 2;
  focused: "confirm" | "reject";
  candidate: QualityPickerCandidate;
};

export type BottomSurfaceMode =
  | { kind: "yolo"; stage: 1 | 2 }
  | { kind: "session-migration"; state: MigrationReviewState }
  | { kind: "permission"; request: PermissionRequest }
  | { kind: "question"; pending: PendingUserQuestionState }
  | { kind: "quality"; pending: PendingQualityDecisionState }
  | { kind: "gate"; gate: GateRequest }
  | { kind: "rewind"; picker: RewindPickerState }
  | { kind: "branch"; picker: BranchPickerState }
  | { kind: "session"; picker: SessionPickerState }
  | { kind: "skill-picker"; picker: SkillPickerState }
  | { kind: "quality-rewrite-confirm"; state: QualityRewriteConfirmState }
  | { kind: "quality-picker"; picker: QualityPickerState }
  | { kind: "model"; picker: ModelPickerState }
  | { kind: "composer" };

export type BottomSurfaceState = {
  yoloStage: 1 | 2 | null;
  migrationReview?: MigrationReviewState | null;
  permissionRequest?: PermissionRequest;
  question: PendingUserQuestionState | null;
  quality?: PendingQualityDecisionState | null;
  gate: GateRequest | null;
  rewind: RewindPickerState | null;
  branch: BranchPickerState | null;
  session: SessionPickerState | null;
  skillPicker: SkillPickerState | null;
  qualityRewriteConfirm?: QualityRewriteConfirmState | null;
  qualityPicker?: QualityPickerState | null;
  model: ModelPickerState | null;
  /** While the Workspace page is active, the four host-decision prompts
   * (permission / gate / question / quality) collapse to a one-row pending
   * strip instead of owning the bottom, so mid-turn arrivals neither occlude
   * the workbench nor yank its keyboard (#268 item 3). Pickers and the other
   * confirms keep their full panels on both pages. */
  suppressDecisionPanels?: boolean;
};

export function resolveBottomSurfaceMode(state: BottomSurfaceState): BottomSurfaceMode {
  if (state.yoloStage) return { kind: "yolo", stage: state.yoloStage };
  // The migration review outranks the session picker it opens over (the
  // picker stays open underneath when the review is cancelled).
  if (state.migrationReview) return { kind: "session-migration", state: state.migrationReview };
  if (!state.suppressDecisionPanels) {
    if (state.permissionRequest) return { kind: "permission", request: state.permissionRequest };
    if (state.quality) return { kind: "quality", pending: state.quality };
    if (state.question) return { kind: "question", pending: state.question };
    if (state.gate) return { kind: "gate", gate: state.gate };
  }
  if (state.rewind) return { kind: "rewind", picker: state.rewind };
  if (state.branch) return { kind: "branch", picker: state.branch };
  if (state.session) return { kind: "session", picker: state.session };
  if (state.skillPicker) return { kind: "skill-picker", picker: state.skillPicker };
  if (state.qualityRewriteConfirm) return { kind: "quality-rewrite-confirm", state: state.qualityRewriteConfirm };
  if (state.qualityPicker) return { kind: "quality-picker", picker: state.qualityPicker };
  if (state.model) return { kind: "model", picker: state.model };
  return { kind: "composer" };
}

/** Short label for the pending-decision strip, or null when the top-of-stack
 * surface is not one of the four decision prompts the Workspace page strips.
 * Ranking mirrors the unsuppressed mode resolution so the strip never claims a
 * prompt that another active surface (yolo, migration) actually covers. */
export function pendingDecisionPromptLabel(state: BottomSurfaceState): string | null {
  switch (resolveBottomSurfaceMode({ ...state, suppressDecisionPanels: false }).kind) {
    case "permission": return "Permission";
    case "quality": return "Quality decision";
    case "question": return "Question";
    case "gate": return "Stop gate";
    default: return null;
  }
}

/** The strip line rendered above the composer while the Workspace page defers
 * a host decision to the Chat page. Rendering and tests share this exact
 * string so the affordance stays discoverable. */
export function pendingDecisionStripLine(label: string, width: number): string {
  return truncateLine(`◆ ${label} pending · Ctrl+O to answer`, width);
}

export type BottomSurfaceProps = BottomSurfaceState & {
  layout: ResponsiveTuiLayout;
  composerFocused: boolean;
  gateFocus: GateFocusTarget;
  gateFeedbackMode: GateFocusTarget | null;
  gateFeedback: string;
  gateFeedbackCursor: number;
  engineSwitchPending: boolean;
  questionSelected: number;
  qualitySelected: number;
  questionFreeformText: string;
  questionFreeformCursor: number;
  /** Body-reading focus zone of the open decision prompt (#268 item 4). */
  promptZone?: PromptZone;
  bodyScrollOffset?: number;
  onBodyExtent?: (total: number, visible: number) => void;
  modelItems: OptionItem[];
  modelTitle: string;
  skillPickerItems: OptionItem[];
  skillPickerTitle: string;
  qualityPickerItems: OptionItem[];
  qualityPickerTitle: string;
  qualityRewriteConfirm: QualityRewriteConfirmState | null;
  commandMenuOpen: boolean;
  commandItems: Command[];
  commandSelected: number;
  commandArgumentMenuOpen: boolean;
  commandArgumentItems: OptionItem[];
  commandArgumentSelected: number;
  commandArgumentDraft: CommandArgumentCompletion | null;
  composerPopupMaxRows: number;
  composerPopupOpen: boolean;
  inputNeedsExpandedBottom: boolean;
  inputValue: string;
  inputCursor: number;
  inputWidth: number;
  busy: boolean;
  queuedInputs: QueuedInput[];
  providerConfigReady: boolean;
};

export function BottomSurface(props: BottomSurfaceProps) {
  const mode = () => resolveBottomSurfaceMode(props);
  const queuedRows = () => queuedInputPreviewRows(
    props.queuedInputs,
    props.layout.width - 4,
    props.composerPopupOpen ? 0 : Math.min(4, Math.max(1, props.layout.bottomHeight - 3)),
    props.busy,
  );
  return (
    <Switch>
      <Match when={mode().kind === "yolo" && mode() as Extract<BottomSurfaceMode, { kind: "yolo" }> }>
        {(current) => (
          <box height={props.layout.bottomHeight}>
            <YoloPrompt stage={current().stage} focused={props.gateFocus} width={props.layout.width} />
          </box>
        )}
      </Match>
      <Match when={mode().kind === "session-migration" && mode() as Extract<BottomSurfaceMode, { kind: "session-migration" }> }>
        {(current) => (
          <box height={props.layout.bottomHeight}>
            <MigrationPrompt state={current().state} width={props.layout.width} />
          </box>
        )}
      </Match>
      <Match when={mode().kind === "permission" && mode() as Extract<BottomSurfaceMode, { kind: "permission" }> }>
        {(current) => (
          <box height={props.layout.bottomHeight}>
            <PermissionPrompt
              request={current().request}
              focused={props.gateFocus}
              feedbackMode={props.gateFeedbackMode}
              feedback={props.gateFeedback}
              feedbackCursor={props.gateFeedbackCursor}
              width={props.layout.width}
              zone={props.promptZone}
              bodyScrollOffset={props.bodyScrollOffset}
              onBodyExtent={props.onBodyExtent}
            />
          </box>
        )}
      </Match>
      <Match when={mode().kind === "question" && mode() as Extract<BottomSurfaceMode, { kind: "question" }> }>
        {(current) => (
          <box height={props.layout.bottomHeight}>
            <QuestionPrompt
              question={current().pending.question}
              selected={props.questionSelected}
              width={props.layout.width}
              freeformValue={props.questionFreeformText}
              freeformCursor={props.questionFreeformCursor}
              zone={props.promptZone}
              bodyScrollOffset={props.bodyScrollOffset}
              onBodyExtent={props.onBodyExtent}
            />
          </box>
        )}
      </Match>
      <Match when={mode().kind === "quality" && mode() as Extract<BottomSurfaceMode, { kind: "quality" }> }>
        {(current) => (
          <box height={props.layout.bottomHeight}>
            <QualityDecisionPrompt
              decision={current().pending.decision}
              selected={props.qualitySelected}
              width={props.layout.width}
              maxVisible={Math.max(1, props.layout.bottomHeight - 3)}
            />
          </box>
        )}
      </Match>
      <Match when={mode().kind === "gate" && mode() as Extract<BottomSurfaceMode, { kind: "gate" }> }>
        {(current) => (
          <box height={props.layout.bottomHeight}>
            <GatePrompt
              gate={current().gate}
              focused={props.gateFocus}
              feedbackMode={props.gateFeedbackMode}
              feedback={props.gateFeedback}
              feedbackCursor={props.gateFeedbackCursor}
              width={props.layout.width}
              maxSummaryLines={gateSummaryLineBudget(
                props.layout.summaryLines,
                gateComposerIsActive(props.gateFocus, props.gateFeedbackMode),
                props.engineSwitchPending ? 1 : 0,
              )}
              showSummaryOption={props.engineSwitchPending}
              zone={props.promptZone}
              bodyScrollOffset={props.bodyScrollOffset}
              onBodyExtent={props.onBodyExtent}
            />
          </box>
        )}
      </Match>
      <Match when={mode().kind === "rewind" && mode() as Extract<BottomSurfaceMode, { kind: "rewind" }> }>
        {(current) => (
          <box height={props.layout.bottomHeight}>
            <RewindPicker state={current().picker} width={props.layout.width} />
          </box>
        )}
      </Match>
      <Match when={mode().kind === "branch" && mode() as Extract<BottomSurfaceMode, { kind: "branch" }> }>
        {(current) => (
          <box height={props.layout.bottomHeight}>
            <BranchPicker state={current().picker} width={props.layout.width} />
          </box>
        )}
      </Match>
      <Match when={mode().kind === "session" && mode() as Extract<BottomSurfaceMode, { kind: "session" }> }>
        {(current) => (
          <box height={props.layout.bottomHeight}>
            <SessionPicker sessions={current().picker.sessions} selected={current().picker.selected} width={props.layout.width} />
          </box>
        )}
      </Match>
      <Match when={mode().kind === "skill-picker" && mode() as Extract<BottomSurfaceMode, { kind: "skill-picker" }> }>
        {(current) => (
          <box height={props.layout.bottomHeight}>
            <OptionPicker
              title={props.skillPickerTitle}
              items={props.skillPickerItems}
              selected={current().picker.selected}
              width={props.layout.width}
              hint="↑/↓ choose · Enter activate · Esc close"
              maxVisible={Math.max(1, props.layout.bottomHeight - 3)}
            />
          </box>
        )}
      </Match>
      <Match when={mode().kind === "model" && mode() as Extract<BottomSurfaceMode, { kind: "model" }> }>
        {(current) => (
          <box height={props.layout.bottomHeight}>
            <OptionPicker
              title={props.modelTitle}
              items={props.modelItems}
              selected={current().picker.selected}
              width={props.layout.width}
              hint="↑/↓ choose · Enter select · Esc back"
              maxVisible={Math.max(1, props.layout.bottomHeight - 3)}
            />
          </box>
        )}
      </Match>
      <Match when={mode().kind === "quality-rewrite-confirm" && mode() as Extract<BottomSurfaceMode, { kind: "quality-rewrite-confirm" }> }>
        {(current) => (
          <box height={props.layout.bottomHeight}>
            <QualityRewritePrompt
              stage={current().state.stage}
              focused={current().state.focused}
              providerAlias={current().state.candidate.providerAlias}
              modelId={current().state.candidate.modelId}
              judgeTimeoutMs={current().state.candidate.judgeTimeoutMs}
              width={props.layout.width}
            />
          </box>
        )}
      </Match>
      <Match when={mode().kind === "quality-picker" && mode() as Extract<BottomSurfaceMode, { kind: "quality-picker" }> }>
        {(current) => (
          <box height={props.layout.bottomHeight}>
            <OptionPicker
              title={props.qualityPickerTitle}
              items={props.qualityPickerItems}
              selected={current().picker.selected}
              width={props.layout.width}
              hint="↑/↓ choose · Enter select · Esc back"
              maxVisible={Math.max(1, props.layout.bottomHeight - 3)}
            />
          </box>
        )}
      </Match>
      <Match when={mode().kind === "composer"}>
        <box height={props.inputNeedsExpandedBottom ? props.layout.bottomHeight : 3} border borderColor={palette.panelBorder} paddingX={1} flexDirection="column">
          <Switch fallback={<box height={0} />}>
            <Match when={props.commandMenuOpen}>
              <box flexDirection="column">
                <CommandMenu
                  commands={props.commandItems}
                  selected={props.commandSelected}
                  width={props.layout.width - 4}
                  maxVisible={props.composerPopupMaxRows}
                />
                <ThemedText content="↑/↓ choose · Tab/Enter complete · Esc cancel" fg={palette.textDim} wrapMode="none" />
              </box>
            </Match>
            <Match when={props.commandArgumentMenuOpen}>
              <box flexDirection="column">
                <ArgumentMenu
                  items={props.commandArgumentItems}
                  selected={props.commandArgumentSelected}
                  width={props.layout.width - 4}
                  maxVisible={props.composerPopupMaxRows}
                />
                <ThemedText content={commandArgumentHint(props.commandArgumentDraft)} fg={palette.textDim} wrapMode="none" />
              </box>
            </Match>
          </Switch>
          <For each={queuedRows()}>
            {(row, index) => <ThemedText content={row} fg={index() === 0 ? palette.brand : palette.textDim} wrapMode="none" />}
          </For>
          <PromptComposer
            value={props.inputValue}
            cursor={props.inputCursor}
            placeholder={props.busy
              ? busyComposerPlaceholder(props.queuedInputs.length)
              : !props.providerConfigReady ? "Loading provider config..." : "Type prompt, Enter send, Ctrl+Enter newline, /help commands"}
            width={props.inputWidth}
            maxLines={Math.max(1, props.layout.bottomHeight - queuedRows().length - (props.composerPopupOpen ? props.composerPopupMaxRows + 3 : 2))}
            focused={props.composerFocused}
          />
        </box>
      </Match>
    </Switch>
  );
}

/** Prompt-level Esc action text for the busy composer/queue hint. Rendering
 * and tests share these exact strings so the affordance stays discoverable. */
export function escInterruptHint(busy: boolean, queuedCount: number): string | undefined {
  if (!busy) return undefined;
  return queuedCount > 0 ? "Esc interrupt & send next" : "Esc interrupt";
}

/** Composer placeholder for a busy turn. The long Esc hint appears only when
 * the queue header cannot also show it, so the two never repeat at 80 columns. */
export function busyComposerPlaceholder(queuedCount: number): string {
  return queuedCount > 0 ? "Type input · Enter queue" : "Type input · Enter queue · Esc interrupt";
}

export function queuedInputPreviewRows(items: QueuedInput[], width: number, maxRows: number, busy: boolean): string[] {
  if (items.length === 0 || maxRows <= 0) return [];
  const hint = escInterruptHint(busy, items.length);
  const rows = [truncateLine(hint ? `Queued ${items.length} · ${hint} · Up edits last` : `Queued ${items.length} · Up edits last`, width)];
  const previewBudget = Math.max(0, maxRows - 1);
  if (previewBudget === 0) return rows;
  const visibleCount = Math.min(items.length, previewBudget);
  for (let index = 0; index < visibleCount; index += 1) {
    const item = items[index]!;
    rows.push(truncateLine(`${index + 1}. ${queuedInputText(item).replace(/\s+/g, " ").trim()}`, width));
  }
  if (items.length > visibleCount) {
    rows[rows.length - 1] = truncateLine(`... +${items.length - visibleCount + 1} more queued`, width);
  }
  return rows;
}
