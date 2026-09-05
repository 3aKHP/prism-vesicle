import { createEffect, createMemo, createSignal, type Accessor } from "solid-js";
import type { TuiKeyEvent } from "../decision-interaction";
import { readingAnchorIndex, readingRows, type ReadingAnchor, type ReadingDocument } from "./document";

type ReadingState = {
  identity: unknown;
  key: string;
  active: boolean;
  expanded: boolean;
  anchor: ReadingAnchor;
};

export function createReadingController(options: {
  document: Accessor<ReadingDocument | null>;
  liveKinds: Accessor<readonly string[]>;
  width: Accessor<number>;
  height: Accessor<number>;
  obscured?: Accessor<boolean>;
}) {
  const states = new Map<string, ReadingState>();
  const [revision, setRevision] = createSignal(0);
  const changed = () => setRevision((value) => value + 1);
  createEffect(() => {
    const live = new Set(options.liveKinds());
    for (const kind of states.keys()) if (!live.has(kind)) states.delete(kind);
    const document = options.document();
    if (document) {
      const previous = states.get(document.kind);
      if (!previous || previous.identity !== document.identity || previous.key !== document.key) {
        states.set(document.kind, {
          identity: document.identity, key: document.key, active: false, expanded: false,
          anchor: { block: 0, offset: 0 },
        });
      } else if (previous.active && document.hidden) {
        previous.expanded = true;
      }
    }
    changed();
  });
  const state = () => {
    revision();
    const document = options.document();
    const current = document ? states.get(document.kind) : undefined;
    return current?.identity === document?.identity && current?.key === document?.key ? current : undefined;
  };
  const active = () => !options.obscured?.() && Boolean(options.document()?.enabled && state()?.active);
  const expanded = () => active() && Boolean(state()?.expanded);
  const rows = createMemo(() => readingRows(options.document()?.blocks ?? [], Math.max(1, options.width() - 4)));
  const capacity = () => Math.max(1, options.height() - 4);
  const start = () => Math.min(
    Math.max(0, rows().length - capacity()),
    readingAnchorIndex(rows(), state()?.anchor ?? { block: 0, offset: 0 }),
  );
  function scroll(index: number): void {
    const current = state();
    const row = rows()[Math.max(0, Math.min(index, rows().length - capacity()))];
    if (!current || !row) return;
    current.anchor = { block: row.block, offset: row.offset };
    changed();
  }
  function handleKey(key: TuiKeyEvent): boolean {
    if (options.obscured?.() || !options.document()?.enabled) return false;
    const current = state();
    if (!current) return false;
    if (!current.active) {
      if (key.name !== "tab" || key.ctrl || key.meta || key.option) return false;
      current.active = true;
      current.expanded = options.document()!.hidden;
      changed();
      return true;
    }
    if (key.name === "tab" || key.name === "escape" || key.name === "enter" || key.name === "return") {
      current.active = false;
      current.expanded = false;
      changed();
      return true;
    }
    if (key.name === "up" || (key.ctrl && key.name === "p")) scroll(start() - 1);
    else if (key.name === "down" || (key.ctrl && key.name === "n")) scroll(start() + 1);
    else if (key.name === "home") scroll(0);
    else if (key.name === "end") scroll(rows().length);
    return true;
  }
  return { active, expanded, rows, start, capacity, handleKey, document: options.document };
}

export type ReadingController = ReturnType<typeof createReadingController>;
