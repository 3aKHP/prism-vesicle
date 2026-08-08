/**
 * One-line Workspace status composition (Issue #118 §6/§8).
 *
 * The status row is a single `wrapMode="none"` line, so width pressure used to
 * clip its tail — hiding whatever landed last, which was usually the validation
 * verdict or a destructive choice. This module owns the presentation policy
 * instead: each surface builds an ordered, priority-tagged segment list, and
 * `composeStatus` drops whole low-priority segments before middle-truncating a
 * path/target, so a key label is never cut in half and a warning is never
 * pushed off the row by a long path.
 *
 * Boundary: pure presentation only. The controller owns state transitions; the
 * view owns layout. Builders take explicit per-surface inputs, never the whole
 * controller, so unrelated TUI surfaces cannot grow into this contract.
 *
 * Hot path: `statusLine` recomputes on every keystroke, so the composition
 * caches each segment's display width once and derives the joined width from
 * the cache rather than re-running `displayWidth` (Bun.stringWidth) per drop
 * pass or shrink iteration.
 */
import { displayWidth, truncateMiddle } from "../format";

/** Middle-truncate a path/target to `budget` display columns (never below 8). */
export function truncatePath(path: string, budget: number): string {
  return truncateMiddle(path, Math.max(8, Math.floor(budget)));
}

/** Drop order is low → medium → high; `critical` is never dropped. */
export type StatusPriority = "critical" | "high" | "medium" | "low";

export type StatusSegment = {
  text: string;
  priority: StatusPriority;
  /** Middle-truncate (rather than drop) under width pressure. For paths/targets. */
  shrink?: boolean;
};

const DROP_ORDER: StatusPriority[] = ["low", "medium", "high"];
const SEP = " · ";
const SEP_W = displayWidth(SEP);
const MIN = 8;

/** A segment with its display width cached so the hot path avoids re-measuring. */
type Item = { seg: StatusSegment; w: number };

function mkItems(segments: StatusSegment[]): Item[] {
  return segments
    .filter((s) => s.text.length > 0)
    .map((seg) => ({ seg, w: displayWidth(seg.text) }));
}

/** Joined display width from cached per-segment widths (no `displayWidth` calls). */
function itemsWidth(items: Item[]): number {
  if (items.length === 0) return 0;
  let sum = 0;
  for (const it of items) sum += it.w;
  return sum + SEP_W * (items.length - 1);
}

function joinItems(items: Item[]): string {
  return items.map((it) => it.seg.text).join(SEP);
}

/**
 * Compose a one-line status string that fits `budget` display columns. Whole
 * low-priority segments drop first; AFTER each drop tier the path/target is
 * middle-truncated before the next tier is sacrificed, so a long or CJK path
 * compresses instead of crowding out the medium m/v actions at 80 columns
 * (Issue #118 review round 2). A final hard middle-truncate guarantees the
 * result never exceeds the budget.
 */
export function composeStatus(segments: StatusSegment[], budget: number): string {
  const limit = Math.max(MIN, Math.floor(budget));
  let items = mkItems(segments);
  if (itemsWidth(items) <= limit) return joinItems(items);
  // Drop non-shrinkable segments from low priority upward. A `shrink` segment
  // (the target/path/draft) is retained through dropping. After each tier is
  // dropped, shrink the path/target and re-check — only if that still does not
  // fit do we drop the next (higher) tier, so the medium m/v actions survive a
  // long path at the 80-column floor.
  for (const prio of DROP_ORDER) {
    items = items.filter((it) => it.seg.priority !== prio || it.seg.shrink);
    if (itemsWidth(items) <= limit) return joinItems(items);
    items = shrinkToFit(items, limit);
    if (itemsWidth(items) <= limit) return joinItems(items);
  }
  const joined = joinItems(items);
  return displayWidth(joined) <= limit ? joined : truncateMiddle(joined, limit);
}

/**
 * Iteratively middle-truncate segments until the line fits. Prefers `shrink`
 * segments; once none can shrink further, falls back to truncating the widest
 * remaining segment so the width invariant always holds (Issue #118 §8). Works
 * from cached widths and re-measures only the one segment mutated per pass.
 */
function shrinkToFit(items: Item[], limit: number): Item[] {
  const result = items.map((it) => ({ ...it, seg: { ...it.seg } }));
  for (let guard = 0; guard < 256; guard += 1) {
    const total = itemsWidth(result);
    if (total <= limit) break;
    const over = total - limit;
    let target = -1;
    let widest = -1;
    // First pass: the widest shrink-flagged segment that can still shrink.
    for (let i = 0; i < result.length; i += 1) {
      const it = result[i]!;
      if (!it.seg.shrink) continue;
      const next = Math.max(MIN, it.w - Math.max(1, over));
      if (next >= it.w) continue;
      if (it.w > widest) { widest = it.w; target = i; }
    }
    // Fall back to any widest segment if no shrink segment can shrink further.
    if (target < 0) {
      for (let i = 0; i < result.length; i += 1) {
        const it = result[i]!;
        const next = Math.max(MIN, it.w - Math.max(1, over));
        if (next >= it.w) continue;
        if (it.w > widest) { widest = it.w; target = i; }
      }
    }
    if (target < 0) break;
    const it = result[target]!;
    const newW = Math.max(MIN, it.w - Math.max(1, over));
    it.seg.text = truncateMiddle(it.seg.text, newW);
    it.w = displayWidth(it.seg.text);
  }
  return result;
}

// —— per-surface builders ——

/** Validation summary text bound to this surface's target, or "" when it does not bind. */
export type ValidationText = string;

/**
 * Append a controller status `note` (save/reload/refusal/error message) to a
 * surface. It is `critical` so it survives width pressure alongside the
 * validation verdict; without it the controller's `status(...)` messages would
 * be set but never rendered (Issue #118 review: status-text orphan).
 */
function withNote(segs: StatusSegment[], note: string | undefined): StatusSegment[] {
  if (note && note.length > 0) segs.push({ text: note, priority: "critical" });
  return segs;
}

export type TreeStatusInput = {
  budget: number;
  /** Selected row is a regular file (so `v` can validate it). */
  selectedIsFile: boolean;
  validation: ValidationText;
  /** Controller status text (e.g. "select a file to validate"), or "". */
  note?: string;
};

export function treeStatus(input: TreeStatusInput): string {
  const segs: StatusSegment[] = [];
  if (input.validation) segs.push({ text: input.validation, priority: "critical" });
  segs.push(
    { text: "↑↓ nav", priority: "critical" },
    { text: "Enter open", priority: "critical" },
  );
  if (input.selectedIsFile) segs.push({ text: "v validate", priority: "critical" });
  segs.push(
    { text: "a file", priority: "medium" },
    { text: "A dir", priority: "medium" },
    { text: "m rename", priority: "low" },
    { text: "c copy", priority: "low" },
    { text: "d delete", priority: "low" },
    { text: "r refresh", priority: "low" },
    { text: ". hidden", priority: "low" },
  );
  return composeStatus(withNote(segs, input.note), input.budget);
}

export type ViewerStatusInput = {
  budget: number;
  target: string;
  /** "preview" / "source view" / "viewer" — the viewing-mode label (Issue #118 §5). */
  mode: string;
  /** Restriction flags joined into one segment, e.g. "RO" / "link" / "truncated". */
  flags: string;
  validation: ValidationText;
  /** Reachable mode toggle hint, e.g. "m edit" / "m source" / "m preview", or "". */
  toggleHint: string;
  /** Whether `v findings` is reachable (a current result exists and the target is not dirty). */
  canViewFindings: boolean;
  /** Controller status text (e.g. "reloaded <path>", "save <path> before validating"), or "". */
  note?: string;
};

export function viewerStatus(input: ViewerStatusInput): string {
  const segs: StatusSegment[] = [];
  if (input.validation) segs.push({ text: input.validation, priority: "critical" });
  segs.push({ text: input.target, priority: "high", shrink: true });
  const modeAndFlags = input.flags ? `${input.mode} · ${input.flags}` : input.mode;
  segs.push({ text: modeAndFlags, priority: "high" });
  if (input.toggleHint) segs.push({ text: input.toggleHint, priority: "medium" });
  if (input.canViewFindings) segs.push({ text: "v findings", priority: "medium" });
  segs.push({ text: "r reload", priority: "low" });
  segs.push({ text: "Esc", priority: "critical" });
  return composeStatus(withNote(segs, input.note), input.budget);
}

export type EditorStatusInput = {
  budget: number;
  target: string;
  /** "●" when dirty, else "". */
  dirtyMark: string;
  /** "†disk" when externally changed, else "". */
  diskMark: string;
  cursor: string;
  validation: ValidationText;
  /** Controller status text (e.g. "saved <path>", LRU-refusal, "failed to save …"), or "". */
  note?: string;
};

export function editorStatus(input: EditorStatusInput): string {
  const segs: StatusSegment[] = [];
  if (input.validation) segs.push({ text: input.validation, priority: "critical" });
  segs.push({ text: input.target, priority: "high", shrink: true });
  if (input.dirtyMark) segs.push({ text: input.dirtyMark, priority: "high" });
  if (input.diskMark) segs.push({ text: input.diskMark, priority: "high" });
  segs.push({ text: input.cursor, priority: "critical" });
  segs.push({ text: "Ctrl+S save", priority: "critical" });
  segs.push(
    { text: "Ctrl+F find", priority: "low" },
    { text: "Ctrl+G line", priority: "low" },
    { text: "Ctrl+X external", priority: "low" },
  );
  segs.push({ text: "Esc", priority: "critical" });
  return composeStatus(withNote(segs, input.note), input.budget);
}

export type FindingsStatusInput = {
  budget: number;
  canJump: boolean;
};

export function findingsStatus(input: FindingsStatusInput): string {
  const segs: StatusSegment[] = [
    { text: "↑↓ nav", priority: "high" },
  ];
  if (input.canJump) segs.push({ text: "Enter jump", priority: "medium" });
  segs.push({ text: "Esc", priority: "high" });
  return composeStatus(segs, input.budget);
}

/** A text-input bar (find / goto / save-as / ops): the cursor survives, the draft shrinks. */
export type InputBarStatusInput = {
  budget: number;
  /** Leading label, e.g. "find:" / "goto line:" / "move notes.txt →:". */
  label: string;
  /** Current draft text ( rendered with the cursor glyph by the caller). */
  draft: string;
  /** Trailing choices/hints after the draft, e.g. "Enter next · Shift+Enter prev · Esc close". */
  choices: string;
};

export function inputBarStatus(input: InputBarStatusInput): string {
  // The choices and the cursor (draft tail) must survive; the label/source and
  // the draft shrink. truncateMiddle keeps the draft tail, so the cursor glyph
  // stays visible.
  const segs: StatusSegment[] = [
    { text: input.label, priority: "high", shrink: true },
    { text: input.draft, priority: "critical", shrink: true },
  ];
  if (input.choices) segs.push({ text: input.choices, priority: "critical" });
  return composeStatus(segs, input.budget);
}

/** A confirmation dialog: the target shrinks; the choices always survive. */
export type DialogStatusInput = {
  budget: number;
  /** Lead text identifying the target, e.g. "delete <path>?" (may contain a path). */
  lead: string;
  /** The destructive/committing choices, e.g. "y delete · any other key cancels". */
  choices: string;
};

export function dialogStatus(input: DialogStatusInput): string {
  const segs: StatusSegment[] = [
    { text: input.lead, priority: "high", shrink: true },
    { text: input.choices, priority: "critical" },
  ];
  return composeStatus(segs, input.budget);
}
