import { ThemedText } from "../theme-text";
import { createEffect, createSignal } from "solid-js";
import type { MarkdownRenderable } from "@3akhp/opentui-core";
import { prepareMarkdownForDisplay, renderMarkdownPlainText } from "../markdown-display";
import { debugLog } from "../debug-log";
import { palette, syntaxStyle } from "../theme";

type MarkdownRenderer = "markdown" | "plain";

let loggedMarkdownMode = false;

export function markdownRendererMode(
  _platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
): MarkdownRenderer {
  const requested = env.VESICLE_MARKDOWN_RENDERER?.trim().toLowerCase();
  if (requested === "markdown") return "markdown";
  if (requested === "plain" || requested === "text") return "plain";
  return "markdown";
}

export function MarkdownContent(props: { content: string; fg?: string }) {
  const mode = markdownRendererMode();
  if (!loggedMarkdownMode) {
    loggedMarkdownMode = true;
    debugLog("markdown renderer mode", {
      mode,
      platform: process.platform,
      forced: process.env.VESICLE_MARKDOWN_RENDERER ?? "",
    });
  }
  if (mode === "plain") {
    return <ThemedText content={renderMarkdownPlainText(props.content)} fg={props.fg ?? palette.textPrimary} />;
  }

  const [markdown, setMarkdown] = createSignal<MarkdownRenderable>();
  const initialSyntaxStyle = syntaxStyle();
  const initialForeground = props.fg ?? palette.textPrimary;
  const initialSelectionBackground = palette.selectionBackground;
  const initialSelectionForeground = palette.selectionForeground;
  let appliedSyntaxStyle = initialSyntaxStyle;
  let appliedForeground = initialForeground;
  let appliedSelectionBackground = initialSelectionBackground;
  let appliedSelectionForeground = initialSelectionForeground;
  createEffect(() => {
    const nextSyntaxStyle = syntaxStyle();
    const nextForeground = props.fg ?? palette.textPrimary;
    const nextSelectionBackground = palette.selectionBackground;
    const nextSelectionForeground = palette.selectionForeground;
    const renderable = markdown();
    if (!renderable) return;
    if (
      appliedSyntaxStyle === nextSyntaxStyle
      && appliedForeground === nextForeground
      && appliedSelectionBackground === nextSelectionBackground
      && appliedSelectionForeground === nextSelectionForeground
    ) return;
    appliedSyntaxStyle = nextSyntaxStyle;
    appliedForeground = nextForeground;
    appliedSelectionBackground = nextSelectionBackground;
    appliedSelectionForeground = nextSelectionForeground;
    renderable.syntaxStyle = nextSyntaxStyle;
    renderable.fg = nextForeground;
    renderable.selectionBg = nextSelectionBackground;
    renderable.selectionFg = nextSelectionForeground;
    renderable.refreshStyles();
  });

  return (
    <markdown
      ref={(value: MarkdownRenderable) => { setMarkdown(value); }}
      content={prepareMarkdownForDisplay(props.content)}
      syntaxStyle={initialSyntaxStyle}
      fg={initialForeground}
      selectionBg={initialSelectionBackground}
      selectionFg={initialSelectionForeground}
      conceal={true}
    />
  );
}
