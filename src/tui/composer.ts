import { moveComposerCursorVisual } from "./composer-layout";

export type ComposerKey = {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  option?: boolean;
  shift?: boolean;
  sequence?: string;
  raw?: string;
};

export type ComposerState = {
  value: string;
  cursor: number;
  killBuffer?: string;
  elements?: ComposerElement[];
};

export type ComposerElement = {
  type: "image";
  attachmentId: string;
  placeholder: string;
  start: number;
  end: number;
};

export type ComposerAction =
  | { type: "submit"; value: string; elements?: ComposerElement[] }
  | { type: "history_up" }
  | { type: "history_down" };

export type ComposerResult = {
  state: ComposerState;
  handled: boolean;
  action?: ComposerAction;
};

export type ComposerKeyOptions = {
  columns?: number;
};

export function applyComposerKey(state: ComposerState, key: ComposerKey, options: ComposerKeyOptions = {}): ComposerResult {
  const cursor = normalizeElementCursor(clampCursor(state.cursor, state.value), state.elements);
  const current: ComposerState = { ...state, cursor };
  const name = normalizeKeyName(key.name);

  if (isShiftEnterOnly(key, name)) {
    return handled(current);
  }

  if (isCtrlNewlineKey(key, name)) {
    return handled(insertText(current, "\n"));
  }

  if (key.ctrl && name && name !== "enter" && name !== "return") {
    return applyCtrlKey(current, name, options);
  }

  if ((key.meta || key.option) && name) {
    const metaResult = applyMetaKey(current, name);
    if (metaResult.handled) return metaResult;
  }

  switch (name) {
    case "backspace":
      return handled(deleteBefore(current));
    case "delete":
      return handled(deleteAfter(current));
    case "left":
      return handled({ ...current, cursor: moveCursorAcrossElements(cursor, -1, current.elements) });
    case "right":
      return handled({ ...current, cursor: moveCursorAcrossElements(cursor, 1, current.elements, current.value.length) });
    case "home":
      return handled({ ...current, cursor: lineStart(current.value, cursor) });
    case "end":
      return handled({ ...current, cursor: lineEnd(current.value, cursor) });
    case "up":
      return moveUpOrHistory(current, options);
    case "down":
      return moveDownOrHistory(current, options);
    case "enter":
    case "return":
      return applyEnter(current, key);
    case "tab":
      return handled(insertText(current, "  "));
  }

  const text = printableTextFromKey(key);
  if (text.length === 0) return { state: current, handled: false };
  return handled(insertText(current, normalizeInputText(text)));
}

export function insertComposerText(state: ComposerState, text: string): ComposerState {
  return insertText({ ...state, cursor: clampCursor(state.cursor, state.value) }, normalizeInputText(text));
}

export function insertComposerImage(
  state: ComposerState,
  attachmentId: string,
  placeholder: string,
): ComposerState {
  const current = { ...state, cursor: clampCursor(state.cursor, state.value) };
  const start = current.cursor;
  const next = insertText(current, placeholder);
  return {
    ...next,
    elements: [
      ...(next.elements ?? []),
      { type: "image" as const, attachmentId, placeholder, start, end: start + placeholder.length },
    ].sort((left, right) => left.start - right.start),
  };
}

export function setComposerValue(value: string, cursor = value.length): ComposerState {
  return { value, cursor: clampCursor(cursor, value) };
}

function applyCtrlKey(state: ComposerState, name: string, options: ComposerKeyOptions): ComposerResult {
  switch (name) {
    case "a":
      return handled({ ...state, cursor: lineStart(state.value, state.cursor) });
    case "b":
      return handled({ ...state, cursor: moveCursorAcrossElements(state.cursor, -1, state.elements) });
    case "e":
      return handled({ ...state, cursor: lineEnd(state.value, state.cursor) });
    case "f":
      return handled({ ...state, cursor: moveCursorAcrossElements(state.cursor, 1, state.elements, state.value.length) });
    case "h":
      return handled(deleteBefore(state));
    case "k":
      return handled(killToLineEnd(state));
    case "n":
      return moveDownOrHistory(state, options);
    case "p":
      return moveUpOrHistory(state, options);
    case "u":
      return handled(killToLineStart(state));
    case "w":
      return handled(killWordBefore(state));
    case "y":
      return handled(insertText(state, state.killBuffer ?? ""));
  }
  return { state, handled: false };
}

function applyMetaKey(state: ComposerState, name: string): ComposerResult {
  switch (name) {
    case "b":
      return handled({ ...state, cursor: directionalElementCursor(previousWordOffset(state.value, state.cursor), -1, state.elements) });
    case "f":
      return handled({ ...state, cursor: directionalElementCursor(nextWordOffset(state.value, state.cursor), 1, state.elements) });
    case "backspace":
      return handled(killWordBefore(state));
    case "delete":
    case "d":
      return handled(killWordAfter(state));
  }
  return { state, handled: false };
}

function applyEnter(state: ComposerState, key: ComposerKey): ComposerResult {
  if (state.cursor > 0 && state.value[state.cursor - 1] === "\\") {
    const withoutSlash = deleteRange(state, state.cursor - 1, state.cursor);
    return handled(insertText(withoutSlash, "\n"));
  }
  return {
    state,
    handled: true,
    action: {
      type: "submit",
      value: state.value,
      ...(state.elements?.length ? { elements: cloneElements(state.elements) } : {}),
    },
  };
}

function isShiftEnterOnly(key: ComposerKey, name: string | undefined): boolean {
  return key.shift === true && key.ctrl !== true && (name === "enter" || name === "return" || name === "linefeed");
}

function isCtrlNewlineKey(key: ComposerKey, name: string | undefined): boolean {
  return name === "linefeed" || (key.ctrl === true && (name === "enter" || name === "return" || name === "j")) || isEnhancedNewlineSequence(key);
}

function isEnhancedNewlineSequence(key: ComposerKey): boolean {
  const sequence = key.sequence ?? key.raw ?? "";
  const match = /^\x1b\[13;([56])u$/.exec(sequence);
  return Boolean(match);
}

function moveUpOrHistory(state: ComposerState, options: ComposerKeyOptions): ComposerResult {
  const next = normalizeElementCursor(moveVertical(state.value, state.cursor, -1, options.columns), state.elements);
  if (next !== state.cursor) return handled({ ...state, cursor: next });
  return { state, handled: true, action: { type: "history_up" } };
}

function moveDownOrHistory(state: ComposerState, options: ComposerKeyOptions): ComposerResult {
  const next = normalizeElementCursor(moveVertical(state.value, state.cursor, 1, options.columns), state.elements);
  if (next !== state.cursor) return handled({ ...state, cursor: next });
  return { state, handled: true, action: { type: "history_down" } };
}

function moveVertical(value: string, cursor: number, direction: -1 | 1, columns?: number): number {
  if (columns !== undefined && Number.isFinite(columns) && columns > 0) {
    return moveComposerCursorVisual(value, cursor, direction, columns);
  }

  const start = lineStart(value, cursor);
  const end = lineEnd(value, cursor);
  const column = cursor - start;
  if (direction < 0) {
    if (start === 0) return cursor;
    const previousEnd = start - 1;
    const previousStart = lineStart(value, previousEnd);
    return Math.min(previousStart + column, previousEnd);
  }
  if (end >= value.length) return cursor;
  const nextStart = end + 1;
  const nextEnd = lineEnd(value, nextStart);
  return Math.min(nextStart + column, nextEnd);
}

function insertText(state: ComposerState, text: string): ComposerState {
  if (text.length === 0) return state;
  return {
    ...state,
    value: `${state.value.slice(0, state.cursor)}${text}${state.value.slice(state.cursor)}`,
    cursor: state.cursor + text.length,
    elements: shiftElements(state.elements, state.cursor, text.length),
  };
}

function deleteBefore(state: ComposerState): ComposerState {
  if (state.cursor <= 0) return state;
  return deleteRange(state, state.cursor - 1, state.cursor);
}

function deleteAfter(state: ComposerState): ComposerState {
  if (state.cursor >= state.value.length) return state;
  return deleteRange(state, state.cursor, state.cursor + 1);
}

function killToLineStart(state: ComposerState): ComposerState {
  const start = lineStart(state.value, state.cursor);
  return killRange(state, start, state.cursor);
}

function killToLineEnd(state: ComposerState): ComposerState {
  const end = lineEnd(state.value, state.cursor);
  return killRange(state, state.cursor, end);
}

function killWordBefore(state: ComposerState): ComposerState {
  const start = previousWordOffset(state.value, state.cursor);
  return killRange(state, start, state.cursor);
}

function killWordAfter(state: ComposerState): ComposerState {
  const end = nextWordOffset(state.value, state.cursor);
  return killRange(state, state.cursor, end);
}

function killRange(state: ComposerState, start: number, end: number): ComposerState {
  const expanded = expandRangeForElements(start, end, state.elements);
  const killed = textWithoutElements(state.value, expanded.start, expanded.end, state.elements);
  return { ...deleteRange(state, expanded.start, expanded.end), killBuffer: killed };
}

function deleteRange(state: ComposerState, start: number, end: number): ComposerState {
  const expanded = expandRangeForElements(start, end, state.elements);
  const removed = expanded.end - expanded.start;
  const elements = (state.elements ?? [])
    .filter((element) => element.end <= expanded.start || element.start >= expanded.end)
    .map((element) => element.start >= expanded.end
      ? { ...element, start: element.start - removed, end: element.end - removed }
      : { ...element });
  return renumberImageElements({
    ...state,
    value: `${state.value.slice(0, expanded.start)}${state.value.slice(expanded.end)}`,
    cursor: expanded.start,
    elements,
  });
}

function renumberImageElements(state: ComposerState): ComposerState {
  let value = state.value;
  let cursor = state.cursor;
  let delta = 0;
  const elements = [...(state.elements ?? [])]
    .sort((left, right) => left.start - right.start)
    .map((element, index) => {
      const start = element.start + delta;
      const end = element.end + delta;
      const placeholder = `[Image #${index + 1}]`;
      value = `${value.slice(0, start)}${placeholder}${value.slice(end)}`;
      const lengthDelta = placeholder.length - (end - start);
      if (cursor >= end) cursor += lengthDelta;
      delta += lengthDelta;
      return {
        ...element,
        placeholder,
        start,
        end: start + placeholder.length,
      };
    });
  return { ...state, value, cursor, elements };
}

function expandRangeForElements(start: number, end: number, elements: ComposerElement[] | undefined): { start: number; end: number } {
  let expandedStart = start;
  let expandedEnd = end;
  let changed = true;
  while (changed) {
    changed = false;
    for (const element of elements ?? []) {
      if (element.end <= expandedStart || element.start >= expandedEnd) continue;
      const nextStart = Math.min(expandedStart, element.start);
      const nextEnd = Math.max(expandedEnd, element.end);
      if (nextStart !== expandedStart || nextEnd !== expandedEnd) changed = true;
      expandedStart = nextStart;
      expandedEnd = nextEnd;
    }
  }
  return { start: expandedStart, end: expandedEnd };
}

function textWithoutElements(value: string, start: number, end: number, elements: ComposerElement[] | undefined): string {
  let text = value.slice(start, end);
  for (const element of [...(elements ?? [])].sort((left, right) => right.start - left.start)) {
    if (element.start < start || element.end > end) continue;
    text = `${text.slice(0, element.start - start)}${text.slice(element.end - start)}`;
  }
  return text;
}

function shiftElements(elements: ComposerElement[] | undefined, offset: number, delta: number): ComposerElement[] {
  return (elements ?? []).map((element) => element.start >= offset
    ? { ...element, start: element.start + delta, end: element.end + delta }
    : { ...element });
}

function normalizeElementCursor(cursor: number, elements: ComposerElement[] | undefined): number {
  for (const element of elements ?? []) {
    if (cursor > element.start && cursor < element.end) return element.end;
  }
  return cursor;
}

function directionalElementCursor(cursor: number, direction: -1 | 1, elements: ComposerElement[] | undefined): number {
  for (const element of elements ?? []) {
    if (cursor > element.start && cursor < element.end) return direction < 0 ? element.start : element.end;
  }
  return cursor;
}

function moveCursorAcrossElements(cursor: number, direction: -1 | 1, elements: ComposerElement[] | undefined, length = Number.MAX_SAFE_INTEGER): number {
  const target = direction < 0 ? Math.max(0, cursor - 1) : Math.min(length, cursor + 1);
  for (const element of elements ?? []) {
    if (target > element.start && target < element.end) return direction < 0 ? element.start : element.end;
  }
  return target;
}

function cloneElements(elements: ComposerElement[] | undefined): ComposerElement[] {
  return (elements ?? []).map((element) => ({ ...element }));
}

function previousWordOffset(value: string, cursor: number): number {
  let index = cursor;
  while (index > 0 && /\s/.test(value[index - 1] ?? "")) index -= 1;
  while (index > 0 && !/\s/.test(value[index - 1] ?? "")) index -= 1;
  return index;
}

function nextWordOffset(value: string, cursor: number): number {
  let index = cursor;
  while (index < value.length && /\s/.test(value[index] ?? "")) index += 1;
  while (index < value.length && !/\s/.test(value[index] ?? "")) index += 1;
  return index;
}

function lineStart(value: string, cursor: number): number {
  return value.lastIndexOf("\n", Math.max(0, cursor - 1)) + 1;
}

function lineEnd(value: string, cursor: number): number {
  const index = value.indexOf("\n", cursor);
  return index === -1 ? value.length : index;
}

function printableTextFromKey(key: ComposerKey): string {
  if (key.ctrl || key.meta || key.option) return "";
  const sequence = key.sequence ?? key.raw;
  if (sequence && isPrintableSequence(sequence)) return sequence;
  if (key.name && key.name.length === 1) return key.name;
  return "";
}

function isPrintableSequence(value: string): boolean {
  if (value.length === 0) return false;
  if (value.startsWith("\x1b")) return false;
  return [...value].every((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code >= 0x20 && code !== 0x7f;
  });
}

function normalizeInputText(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function normalizeKeyName(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const normalized = name.toLowerCase();
  if (normalized === "return") return "enter";
  if (normalized === "del") return "delete";
  if (normalized === "up_arrow" || normalized === "uparrow") return "up";
  if (normalized === "down_arrow" || normalized === "downarrow") return "down";
  if (normalized === "left_arrow" || normalized === "leftarrow") return "left";
  if (normalized === "right_arrow" || normalized === "rightarrow") return "right";
  return normalized;
}

function clampCursor(cursor: number, value: string): number {
  return Math.max(0, Math.min(value.length, cursor));
}

function handled(state: ComposerState): ComposerResult {
  return { state, handled: true };
}
