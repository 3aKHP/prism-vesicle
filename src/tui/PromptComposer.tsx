import { For } from "solid-js";
import { TextAttributes, createTextAttributes } from "@opentui/core";
import { layoutComposerText } from "./composer-layout";
import { displayWidth } from "./format";
import { palette } from "./theme";

export type PromptComposerProps = {
  value: string;
  cursor: number;
  placeholder: string;
  width: number;
  maxLines: number;
  focused?: boolean;
};

export function PromptComposer(props: PromptComposerProps) {
  const renderedLines = () => renderComposerLines(
    props.value,
    props.cursor,
    props.placeholder,
    Math.max(8, props.width),
    Math.max(1, props.maxLines),
    props.focused !== false,
  );

  return (
    <box flexDirection="column" width="100%">
      <For each={renderedLines()}>
        {(line) => (
          <box height={1} flexDirection="row">
            <text content={line.prefix} fg={line.placeholder ? palette.textDim : palette.textPrimary} attributes={TextAttributes.NONE} wrapMode="none" />
            {line.cursor ? (
              <text
                content={line.cursorChar}
                fg={palette.textPrimary}
                attributes={cursorAttributes}
                wrapMode="none"
              />
            ) : null}
            <text content={line.suffix} fg={line.placeholder ? palette.textDim : palette.textPrimary} attributes={TextAttributes.NONE} wrapMode="none" />
          </box>
        )}
      </For>
    </box>
  );
}

export type RenderedComposerLine = {
  prefix: string;
  suffix: string;
  cursorChar: string;
  placeholder?: boolean;
  cursor?: boolean;
};

const cursorAttributes = createTextAttributes({ inverse: true });

export function renderComposerLines(
  value: string,
  cursor: number,
  placeholder: string,
  width: number,
  maxLines: number,
  focused: boolean,
): RenderedComposerLine[] {
  const contentWidth = Math.max(4, width);
  if (value.length === 0) {
    const placeholderText = clipToChars(placeholder, Math.max(1, contentWidth - (focused ? 1 : 0)));
    return [{
      prefix: "",
      cursor: focused,
      cursorChar: " ",
      suffix: placeholderText,
      placeholder: true,
    }];
  }

  const safeCursor = Math.max(0, Math.min(value.length, cursor));
  const layout = layoutComposerText(value, safeCursor, contentWidth, maxLines);
  const rendered = layout.visibleLines.map((line, index) => renderLineSegments(
    line,
    contentWidth,
    layout.visibleStart + index === layout.cursorLine ? safeCursor : undefined,
    layout.hiddenBefore > 0 && index === 0,
    focused,
  ));
  return rendered.length > 0
    ? rendered
    : [{ prefix: "", suffix: "", cursorChar: " ", cursor: focused }];
}

type ComposerLine = {
  text: string;
  start: number;
  end: number;
};

function renderLineSegments(line: ComposerLine, width: number, cursor: number | undefined, hiddenPrefix: boolean, focused: boolean): RenderedComposerLine {
  const rawText = hiddenPrefix && cursor === undefined ? withHiddenPrefix(line.text) : line.text;
  const cursorColumn = cursor === undefined ? undefined : Math.max(0, Math.min(line.text.length, cursor - line.start));
  if (!focused || cursorColumn === undefined) {
    return {
      prefix: rawText || " ",
      suffix: "",
      cursorChar: " ",
    };
  }

  const safeColumn = Math.max(0, Math.min(rawText.length, cursorColumn));
  if (safeColumn >= rawText.length && displayWidth(rawText) >= width) {
    const previous = charBeforeOffset(rawText, safeColumn);
    return {
      prefix: rawText.slice(0, previous.start),
      cursor: true,
      cursorChar: previous.char,
      suffix: rawText.slice(previous.end),
    };
  }

  const { char: cursorChar, end: cursorEnd } = charAtOffset(rawText, safeColumn);
  return {
    prefix: rawText.slice(0, safeColumn),
    cursor: true,
    cursorChar,
    suffix: rawText.slice(cursorEnd),
  };
}

function clipToChars(value: string, width: number): string {
  const limit = Math.max(4, width);
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 3)}...`;
}

function withHiddenPrefix(value: string): string {
  if (value.length === 0) return "⋯";
  if (value.length === 1) return "⋯";
  return `⋯ ${value.slice(2)}`;
}

function charAtOffset(value: string, offset: number): { char: string; end: number } {
  if (offset >= value.length) return { char: " ", end: offset };
  const codePoint = value.codePointAt(offset);
  if (codePoint === undefined) return { char: " ", end: offset };
  const char = String.fromCodePoint(codePoint);
  return { char, end: offset + char.length };
}

function charBeforeOffset(value: string, offset: number): { char: string; start: number; end: number } {
  const safeOffset = Math.max(0, Math.min(value.length, offset));
  if (safeOffset <= 0) return { char: " ", start: 0, end: 0 };
  const prefix = value.slice(0, safeOffset);
  const chars = [...prefix];
  const char = chars[chars.length - 1] ?? " ";
  const start = safeOffset - char.length;
  return { char, start, end: safeOffset };
}
