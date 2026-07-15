import { For } from "solid-js";
import { TextAttributes } from "@opentui/core";
import type { UserQuestionOption, UserQuestionRequest } from "../core/user-question/types";
import { truncateLine } from "./format";
import { palette } from "./theme";
import { PromptComposer } from "./PromptComposer";

export type QuestionPromptProps = {
  question: UserQuestionRequest;
  selected: number;
  width: number;
  freeformValue?: string;
  freeformCursor?: number;
};

export function questionComposerIsActive(option: UserQuestionOption | undefined): boolean {
  return option?.kind === "freeform";
}

/** Rows required when the selected question option exposes its composer. */
export function questionPanelMinHeight(question: UserQuestionRequest, selected: number): number {
  const composerRows = questionComposerIsActive(question.options[selected]) ? 2 : 0;
  return question.options.length + 4 + composerRows;
}

export function QuestionPrompt(props: QuestionPromptProps) {
  const width = () => Math.max(20, props.width - 4);
  const rows = (): QuestionRow[] => props.question.options.flatMap((option, index) => [
    { kind: "option" as const, option, index },
    ...(index === props.selected && questionComposerIsActive(option)
      ? [{ kind: "freeform" as const }]
      : []),
  ]);

  return (
    <box flexDirection="column" border borderColor={palette.gateBorder} paddingX={1} width="100%" height="100%">
      <box flexDirection="row" height={1}>
        <text content="◆ " fg={palette.gateAccent} wrapMode="none" />
        <text content={props.question.header} fg={palette.gateAccent} attributes={TextAttributes.BOLD} wrapMode="none" />
        <text content="  ↑/↓ choose · Enter answer · free answer accepts typing" fg={palette.textDim} wrapMode="none" />
      </box>
      <box height={1}>
        <text content={truncateLine(props.question.question, width())} fg={palette.textPrimary} width="100%" wrapMode="none" />
      </box>
      <For each={rows()}>
        {(row) => row.kind === "option" ? (
            <box height={1}>
              <text
                content={optionLine(row.index + 1, row.option.label, row.option.description, row.index === props.selected, width())}
                fg={row.index === props.selected ? palette.textPrimary : palette.textSecondary}
                attributes={row.index === props.selected ? TextAttributes.BOLD : TextAttributes.NONE}
                width="100%"
                wrapMode="none"
              />
            </box>
          ) : (
              <box marginLeft={4} height={2} flexDirection="row">
                <text content="✎ " fg={palette.warn} wrapMode="none" />
                <PromptComposer
                  value={props.freeformValue ?? ""}
                  cursor={props.freeformCursor ?? (props.freeformValue ?? "").length}
                  placeholder="Type your answer..."
                  width={Math.max(12, width() - 4)}
                  maxLines={2}
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
