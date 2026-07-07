export const tuiLayout = {
  leftPanelWidth: 30,
  rightPanelWidth: 42,
};

export type ResponsiveTuiLayout = {
  width: number;
  height: number;
  mode: "compact" | "balanced" | "wide";
  showWorkspace: boolean;
  showOutput: boolean;
  leftPanelWidth: number;
  rightPanelWidth: number;
  bottomHeight: number;
  summaryLines: number;
};

export function resolveTuiLayout(width: number, height: number, hasGate: boolean, hasPicker: boolean): ResponsiveTuiLayout {
  const mode = width >= 118 ? "wide" : width >= 96 ? "balanced" : "compact";
  const bottomHeight = hasGate
    ? clamp(Math.floor(height * 0.38), 9, 14)
    : hasPicker
      ? clamp(Math.floor(height * 0.34), 8, 12)
      : 3;

  return {
    width,
    height,
    mode,
    showWorkspace: mode !== "compact" && !hasGate && !hasPicker,
    showOutput: mode === "wide" && !hasGate && !hasPicker,
    leftPanelWidth: mode === "wide" ? 30 : 24,
    rightPanelWidth: 42,
    bottomHeight,
    summaryLines: Math.max(3, bottomHeight - 6),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
