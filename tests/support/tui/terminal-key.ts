import { KeyEvent, parseKeypress, type ParseKeypressOptions } from "@3akhp/opentui-core";

type KeyHandler = (key: KeyEvent) => void;

/**
 * Parse the bytes a terminal actually sends and wrap them in the same KeyEvent
 * class OpenTUI dispatches. Shortcut tests should use this boundary instead of
 * constructing idealized modifier objects that a legacy terminal cannot emit.
 */
export function terminalKeyEvent(sequence: string, options: ParseKeypressOptions = {}): KeyEvent {
  const parsed = parseKeypress(sequence, options);
  if (!parsed) throw new Error(`OpenTUI did not parse terminal key sequence ${JSON.stringify(sequence)}`);
  return new KeyEvent(parsed);
}

/** Dispatch a real terminal sequence and return its consumable OpenTUI event. */
export function dispatchTerminalKey(handler: KeyHandler, sequence: string, options: ParseKeypressOptions = {}): KeyEvent {
  const event = terminalKeyEvent(sequence, options);
  handler(event);
  return event;
}
