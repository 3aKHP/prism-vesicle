type StageMessageShortcutKey = {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  option?: boolean;
};

export const stageMessageToggleShortcut = "Ctrl+Alt+S";

/** Alt is reported as `meta` by legacy terminals and `option` by enhanced protocols. */
export function isStageMessageToggleShortcut(key: StageMessageShortcutKey): boolean {
  return key.ctrl === true && (key.meta === true || key.option === true) && key.name?.toLowerCase() === "s";
}
