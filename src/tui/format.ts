/**
 * Shared text-formatting helpers for the TUI. Pure functions; no JSX, no
 * reactive state. Extracted so view/widget components and the App shell share
 * one truncation discipline.
 */
export function truncateLine(value: string, width: number): string {
  const limit = Math.max(8, width);
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 3)}...`;
}

export function truncateMiddle(value: string, width: number): string {
  const limit = Math.max(8, width);
  if (value.length <= limit) return value;
  const head = Math.ceil((limit - 3) / 2);
  const tail = Math.floor((limit - 3) / 2);
  return `${value.slice(0, head)}...${value.slice(value.length - tail)}`;
}
