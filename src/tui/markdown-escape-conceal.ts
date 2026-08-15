import { TreeSitterClient, type SimpleHighlight } from "@opentui/core";

const ESCAPE_HIGHLIGHT_GROUP = "string.escape";
const MARKDOWN_INLINE_LANGUAGE = "markdown_inline";

let installed = false;

/**
 * Interim host-side fix for markdown backslash escapes rendering literally
 * (upstream defect: anomalyco/opentui#1369). CommonMark renders `\X` as the
 * escaped character, but the vendored markdown_inline highlight query styles
 * `(backslash_escape)` with no conceal rule, and the atomic two-character
 * grammar token cannot be split by any query rule. The proper fix lives in
 * the OpenTUI worker (fork branch `vesicle/fix-markdown-escape`, upstream PR
 * anomalyco/opentui#1370); until Vesicle adopts the fork baseline, this
 * transform rewrites the highlight tuples on the client so the backslash
 * byte is concealed and the escaped character renders as plain text.
 *
 * It wraps `TreeSitterClient.prototype` — not the singleton instance — so
 * clients recreated after `destroyTreeSitterClient()` stay covered, and it
 * ships inside Vesicle's own JavaScript, so every distribution channel
 * (source, npm bundle, standalone binaries) gets it without relying on
 * package-manager patch support. Remove together with the 0.4.3 dependency
 * patch when the fork baseline lands.
 */
export function installMarkdownEscapeConceal(): void {
  if (installed) return;
  installed = true;

  const original = TreeSitterClient.prototype.highlightOnce;
  TreeSitterClient.prototype.highlightOnce = async function (
    this: TreeSitterClient,
    content: string,
    filetype: string,
  ) {
    const result = await original.call(this, content, filetype);
    if (result.highlights?.length) {
      result.highlights = concealMarkdownEscapeBackslashes(content, result.highlights);
    }
    return result;
  };
}

function concealMarkdownEscapeBackslashes(content: string, highlights: SimpleHighlight[]): SimpleHighlight[] {
  return highlights.map((highlight) => {
    const [start, end, group, meta] = highlight;
    // The worker exposes no node types on the main thread, so a
    // backslash_escape capture is identified by shape: a two-character
    // markdown_inline injection styled as an escape whose first byte is a
    // backslash. `~\n` (hard_line_break) is excluded by the newline check.
    if (
      group !== ESCAPE_HIGHLIGHT_GROUP
      || meta?.conceal !== undefined
      || meta?.isInjection !== true
      || meta.injectionLang !== MARKDOWN_INLINE_LANGUAGE
      || end - start !== 2
      || content[start] !== "\\"
      || content[start + 1] === "\n"
    ) {
      return highlight;
    }
    return [start, start + 1, group, { ...meta, conceal: "" }];
  });
}
