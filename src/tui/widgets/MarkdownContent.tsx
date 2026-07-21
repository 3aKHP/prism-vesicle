import { prepareMarkdownForDisplay, renderMarkdownPlainText } from "../markdown-display";
import { debugLog } from "../debug-log";
import { palette, sharedSyntaxStyle } from "../theme";

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
    return <text content={renderMarkdownPlainText(props.content)} fg={props.fg ?? palette.textPrimary} />;
  }
  return <markdown content={prepareMarkdownForDisplay(props.content)} syntaxStyle={sharedSyntaxStyle} conceal={true} />;
}
