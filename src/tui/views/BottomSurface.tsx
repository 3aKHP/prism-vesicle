import { Match, Switch } from "solid-js";
import type { GateRequest } from "../../core/gate/types";
import type { PermissionRequest } from "../../core/permissions";
import type { ResponsiveTuiLayout } from "../layout";
import type { AgentArgumentDraft, FixedArgumentDraft, ModelArgumentDraft } from "../commands/argument-completion";
import type { Command } from "../commands/types";
import { commandArgumentHint } from "../commands/options";
import type { GateFocusTarget } from "../GatePrompt";
import { GatePrompt, gateComposerIsActive, gateSummaryLineBudget } from "../GatePrompt";
import { PermissionPrompt } from "../PermissionPrompt";
import { PromptComposer } from "../PromptComposer";
import { QuestionPrompt } from "../QuestionPrompt";
import { RewindPicker } from "../RewindPicker";
import { SessionPicker } from "../SessionPicker";
import { YoloPrompt } from "../YoloPrompt";
import type { PendingUserQuestionState } from "../decision-interaction";
import type { PendingQualityDecisionState } from "../decision-interaction";
import { QualityDecisionPrompt } from "../QualityDecisionPrompt";
import { palette } from "../theme";
import type { OptionItem, RewindPickerState, SessionPickerState } from "../types";
import { ArgumentMenu } from "../widgets/ArgumentMenu";
import { CommandMenu } from "../widgets/CommandMenu";
import { OptionPicker } from "../widgets/OptionPicker";

export type ModelPickerState = {
  step: "provider" | "model";
  providerId: string | null;
  selected: number;
};

export type BottomSurfaceMode =
  | { kind: "yolo"; stage: 1 | 2 }
  | { kind: "permission"; request: PermissionRequest }
  | { kind: "question"; pending: PendingUserQuestionState }
  | { kind: "quality"; pending: PendingQualityDecisionState }
  | { kind: "gate"; gate: GateRequest }
  | { kind: "rewind"; picker: RewindPickerState }
  | { kind: "session"; picker: SessionPickerState }
  | { kind: "model"; picker: ModelPickerState }
  | { kind: "composer" };

export type BottomSurfaceState = {
  yoloStage: 1 | 2 | null;
  permissionRequest?: PermissionRequest;
  question: PendingUserQuestionState | null;
  quality?: PendingQualityDecisionState | null;
  gate: GateRequest | null;
  rewind: RewindPickerState | null;
  session: SessionPickerState | null;
  model: ModelPickerState | null;
};

export function resolveBottomSurfaceMode(state: BottomSurfaceState): BottomSurfaceMode {
  if (state.yoloStage) return { kind: "yolo", stage: state.yoloStage };
  if (state.permissionRequest) return { kind: "permission", request: state.permissionRequest };
  if (state.quality) return { kind: "quality", pending: state.quality };
  if (state.question) return { kind: "question", pending: state.question };
  if (state.gate) return { kind: "gate", gate: state.gate };
  if (state.rewind) return { kind: "rewind", picker: state.rewind };
  if (state.session) return { kind: "session", picker: state.session };
  if (state.model) return { kind: "model", picker: state.model };
  return { kind: "composer" };
}

export type BottomSurfaceProps = BottomSurfaceState & {
  layout: ResponsiveTuiLayout;
  gateFocus: GateFocusTarget;
  gateFeedbackMode: GateFocusTarget | null;
  gateFeedback: string;
  gateFeedbackCursor: number;
  engineSwitchPending: boolean;
  questionSelected: number;
  qualitySelected: number;
  questionFreeformText: string;
  questionFreeformCursor: number;
  modelItems: OptionItem[];
  modelTitle: string;
  commandMenuOpen: boolean;
  commandItems: Command[];
  commandSelected: number;
  commandArgumentMenuOpen: boolean;
  commandArgumentItems: OptionItem[];
  commandArgumentSelected: number;
  modelArgumentDraft: ModelArgumentDraft | null;
  fixedArgumentDraft: FixedArgumentDraft | null;
  agentArgumentDraft: AgentArgumentDraft | null;
  composerPopupMaxRows: number;
  composerPopupOpen: boolean;
  inputNeedsExpandedBottom: boolean;
  inputValue: string;
  inputCursor: number;
  inputWidth: number;
  busy: boolean;
  providerConfigReady: boolean;
};

export function BottomSurface(props: BottomSurfaceProps) {
  const mode = () => resolveBottomSurfaceMode(props);
  return (
    <Switch>
      <Match when={mode().kind === "yolo" && mode() as Extract<BottomSurfaceMode, { kind: "yolo" }> }>
        {(current) => (
          <box height={props.layout.bottomHeight}>
            <YoloPrompt stage={current().stage} focused={props.gateFocus} width={props.layout.width} />
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
      <Match when={mode().kind === "session" && mode() as Extract<BottomSurfaceMode, { kind: "session" }> }>
        {(current) => (
          <box height={props.layout.bottomHeight}>
            <SessionPicker sessions={current().picker.sessions} selected={current().picker.selected} width={props.layout.width} />
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
                <text content="↑/↓ choose · Tab/Enter complete · Esc cancel" fg={palette.textDim} wrapMode="none" />
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
                <text content={commandArgumentHint(props.modelArgumentDraft, props.fixedArgumentDraft, props.agentArgumentDraft)} fg={palette.textDim} wrapMode="none" />
              </box>
            </Match>
          </Switch>
          <PromptComposer
            value={props.inputValue}
            cursor={props.inputCursor}
            placeholder={props.busy ? "Request in flight..." : !props.providerConfigReady ? "Loading provider config..." : "Type prompt, Enter send, Ctrl+Enter newline, /help commands"}
            width={props.inputWidth}
            maxLines={Math.max(1, props.layout.bottomHeight - (props.composerPopupOpen ? props.composerPopupMaxRows + 3 : 2))}
          />
        </box>
      </Match>
    </Switch>
  );
}
