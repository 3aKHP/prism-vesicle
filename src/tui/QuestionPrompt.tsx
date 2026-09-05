import { ThemedText } from "./theme-text";
import { For, Show } from "solid-js";
import { TextAttributes } from "@3akhp/opentui-core";
import type { UserQuestionOption, UserQuestionRequest } from "../core/user-question/types";
import { type PromptZone, PromptBodyRow, promptBodyZoneHint } from "./GatePrompt";
import { bodyReadAffordance, bodyScrollIndicator, promptBodyWindow, truncateLine, wrapDisplayLines } from "./format";
import { palette } from "./theme";
import { PromptComposer } from "./PromptComposer";

export type QuestionPromptProps = {
  question: UserQuestionRequest;
  selected: number;
  width: number;
  height?: number;
  freeformValue?: string;
  freeformCursor?: number;
  zone?: PromptZone;
};

export function questionComposerIsActive(option: UserQuestionOption | undefined): boolean {
  return option?.kind === "freeform";
}

/** Visible budget for the wrapped question text (#268 item 4): the old
 * single truncated line becomes a wrapped, scrollable block. */
export const questionTextLineBudget = 3;

/** Rows required when the selected question option exposes its composer. */
export function questionPanelMinHeight(question: UserQuestionRequest, selected: number): number {
  const composerRows = questionComposerIsActive(question.options[selected]) ? 2 : 0;
  return question.options.length + 4 + composerRows + questionTextLineBudget - 1;
}

export function QuestionPrompt(props: QuestionPromptProps) {
  const width = () => Math.max(20, props.width - 4);
  const composerRows = () => questionComposerIsActive(props.question.options[props.selected]) ? 2 : 0;
  const optionCapacity = () => props.height === undefined ? props.question.options.length
    : Math.max(1, Math.min(props.question.options.length, props.height - 4 - composerRows()));
  const optionStart = () => Math.max(0, Math.min(props.selected - Math.floor(optionCapacity() / 2), props.question.options.length - optionCapacity()));
  // The gutter column is reserved in every zone so toggling zones never
  // reflows the wrapped question text.
  const questionWindow = () => promptBodyWindow(
    wrapDisplayLines(props.question.question, Math.max(20, width() - 1)),
    props.height === undefined ? questionTextLineBudget : Math.max(1, props.height - 3 - optionCapacity() - composerRows()),
    0,
  );
  const rows = (): QuestionRow[] => props.question.options.flatMap((option, index) => index < optionStart() || index >= optionStart() + optionCapacity() ? [] : [
    { kind: "option" as const, option, index },
    ...(index === props.selected && questionComposerIsActive(option)
      ? [{ kind: "freeform" as const }]
      : []),
  ]);

  return (
    <box flexDirection="column" border borderColor={palette.gateBorder} paddingX={1} width="100%" height="100%">
      <box flexDirection="row" height={1}>
        <ThemedText content="◆ " fg={palette.gateAccent} wrapMode="none" />
        <ThemedText content={truncateLine(props.question.header, Math.max(8, width() - 48))} fg={palette.gateAccent} attributes={TextAttributes.BOLD} wrapMode="none" />
        <ThemedText
          content={props.zone === "body" ? `  ${promptBodyZoneHint}` : "  ↑/↓ choose · Enter answer · Tab read"}
          fg={palette.textDim}
          wrapMode="none"
        />
      </box>
      <box flexDirection="column">
        <For each={questionWindow().lines.slice(questionWindow().start, questionWindow().end)}>
          {(line) => <PromptBodyRow line={line} zone={props.zone} />}
        </For>
        <Show when={questionWindow().showIndicator} fallback={<box height={0} />}>
          <PromptBodyRow
            zone={props.zone}
            fg={props.zone === "body" ? palette.textPrimary : palette.gateAccent}
            line={props.zone === "body"
              ? bodyScrollIndicator(
                  questionWindow().start,
                  questionWindow().start + questionWindow().visible,
                  questionWindow().lines.length,
                  width(),
                )
              : bodyReadAffordance(questionWindow().lines.length - questionWindow().visible, width())}
          />
        </Show>
      </box>
      <For each={rows()}>
        {(row) => row.kind === "option" ? (
            <box height={1}>
              <ThemedText
                content={optionLine(row.index + 1, row.option.label, row.option.description, row.index === props.selected, width())}
                fg={row.index === props.selected ? palette.textPrimary : palette.textSecondary}
                attributes={row.index === props.selected ? TextAttributes.BOLD : TextAttributes.NONE}
                width="100%"
                wrapMode="none"
              />
            </box>
          ) : (
              <box marginLeft={4} height={2} flexDirection="row">
                <ThemedText content="✎ " fg={palette.warn} wrapMode="none" />
                <PromptComposer
                  value={props.freeformValue ?? ""}
                  cursor={props.freeformCursor ?? (props.freeformValue ?? "").length}
                  placeholder="Type your answer..."
                  width={Math.max(12, width() - 4)}
                  maxLines={2}
                  focused={props.zone !== "body"}
                />
              </box>
        )}
      </For>
    </box>
  );
}

type QuestionRow =
  | { kind: "option"; option: UserQuestionOption; index: number }
  | { kind: "freeform" };

export function optionLine(index: number, label: string, description: string, selected: boolean, width: number): string {
  const marker = selected ? ">" : " ";
  return truncateLine(`${marker}${index}. ${label} - ${description}`, width);
}
