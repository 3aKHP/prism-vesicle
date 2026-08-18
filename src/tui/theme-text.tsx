import type { TextRenderable } from "@3akhp/opentui-core";
import type { TextProps } from "@3akhp/opentui-solid";
import { createEffect, splitProps } from "solid-js";
import { palette, paletteFor, themeMode } from "./theme";

export type ThemedTextProps = Omit<TextProps, "selectionBg" | "selectionFg">;

/**
 * Theme-owned selectable text primitive. OpenTUI cannot infer a transparent
 * text buffer's composed parent background, so every selectable Text receives
 * the complete pair instead of relying on its implicit colour swap.
 */
export function ThemedText(props: ThemedTextProps) {
  const [local, rest] = splitProps(props, ["ref"]);
  let renderable: TextRenderable | undefined;
  createEffect(() => {
    const current = paletteFor(themeMode());
    const background = current.selectionBackground;
    const foreground = current.selectionForeground;
    if (!renderable) return;
    renderable.selectionBg = background;
    renderable.selectionFg = foreground;
  });

  return (
    <text
      {...rest}
      ref={(value: TextRenderable) => {
        renderable = value;
        if (typeof local.ref === "function") local.ref(value);
      }}
      selectionBg={palette.selectionBackground}
      selectionFg={palette.selectionForeground}
    />
  );
}
