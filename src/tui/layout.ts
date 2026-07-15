export const tuiLayout = {
  leftPanelWidth: 28,
};

export type ResponsiveTuiLayout = {
  width: number;
  height: number;
  mode: "compact" | "balanced" | "wide";
  showSidebar: boolean;
  leftPanelWidth: number;
  bottomHeight: number;
  summaryLines: number;
  footerHeight: number;
};

export function resolveTuiLayout(
  width: number,
  height: number,
  hasGate: boolean,
  hasPicker: boolean,
  decisionMinHeight = 9,
  pickerMinHeight = 8,
  pickerMaxHeight = 12,
): ResponsiveTuiLayout {
  const mode = width >= 118 ? "wide" : width >= 96 ? "balanced" : "compact";
  const gateMinimum = clamp(decisionMinHeight, 9, 14);
  const pickerMinimum = clamp(pickerMinHeight, 8, 14);
  const pickerMaximum = clamp(Math.max(pickerMaxHeight, pickerMinimum), pickerMinimum, 14);
  const bottomHeight = hasGate
    ? clamp(Math.floor(height * 0.38), gateMinimum, 14)
    : hasPicker
      ? clamp(Math.floor(height * 0.34), pickerMinimum, pickerMaximum)
      : 3;

  return {
    width,
    height,
    mode,
    // Single left sidebar (status + artifacts). Hides at compact width and
    // while a gate/picker owns the bottom, giving those flows the full width.
    showSidebar: mode !== "compact" && !hasGate && !hasPicker,
    leftPanelWidth: mode === "wide" ? 30 : 24,
    bottomHeight,
    summaryLines: Math.max(3, bottomHeight - 6),
    footerHeight: 1,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
