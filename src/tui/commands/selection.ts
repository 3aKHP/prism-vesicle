/** Keep the command-menu cursor inside the current result set. */
export function clampCommandMenuSelection(selected: number, itemCount: number): number {
  if (itemCount <= 0) return 0;
  return Math.max(0, Math.min(selected, itemCount - 1));
}

/** Move one row while preserving a valid selection for empty result sets. */
export function moveCommandMenuSelection(selected: number, delta: -1 | 1, itemCount: number): number {
  return clampCommandMenuSelection(selected + delta, itemCount);
}
