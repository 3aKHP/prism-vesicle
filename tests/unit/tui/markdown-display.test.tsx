import { describe, expect, test } from "bun:test";
import { prepareMarkdownForDisplay, renderMarkdownPlainText } from "../../../src/tui/markdown-display";
import { renderArtifactMarkdownPreview } from "../../../src/tui/widgets/ArtifactCard";
import { markdownRendererMode } from "../../../src/tui/widgets/MarkdownContent";

describe("tui: markdown display", () => {
  test("cleans common markdown markers for artifact preview text cards", () => {
    expect(renderArtifactMarkdownPreview("## Biography\n\n**Bold** and `code`\n- [x] Done"))
      .toBe("Biography\n\nBold and code\n☑ Done");
  });

  test("prepares markdown display with terminal-readable LaTeX math", () => {
    expect(prepareMarkdownForDisplay("Euler: $e^{i\\pi}+1=0$."))
      .toContain("Euler: eⁱπ+1=0.");

    const display = prepareMarkdownForDisplay("$$\\frac{a}{b} = \\sqrt{x}$$");
    expect(display).toContain("⟦");
    expect(display).toContain("(a)/(b)=√(x)");
  });

  test("leaves fenced code untouched while preparing markdown display", () => {
    const source = "```ts\nconst price = \"$5\";\nconst formula = \"$x^2$\";\n```\nOutside $x^2$.";
    expect(prepareMarkdownForDisplay(source))
      .toBe("```ts\nconst price = \"$5\";\nconst formula = \"$x^2$\";\n```\nOutside x².");
  });

  test("artifact preview combines markdown cleanup with LaTeX rendering", () => {
    expect(renderArtifactMarkdownPreview("## Formula\n\nResult: $\\alpha_i^2 \\leq \\frac{a}{b}$"))
      .toBe("Formula\n\nResult: αᵢ²≤(a)/(b)");
  });

  test("prepares terminal-readable Markdown formatting extensions", () => {
    expect(prepareMarkdownForDisplay("==高亮== H~2~O E=mc^2^ <u>下划线</u> <kbd>Ctrl</kbd> :rocket:"))
      .toBe("▰ 高亮 ▰ H₂O E=mc² ＿下划线＿ ‹Ctrl› 🚀");

    expect(prepareMarkdownForDisplay("<abbr title=\"Prism ETL Engine\">ETL</abbr> and <mark>marked</mark>"))
      .toBe("ETL (Prism ETL Engine) and ▰ marked ▰");
  });

  test("uses Markdown by default and keeps an explicit plain-text fallback", () => {
    expect(markdownRendererMode("win32", {})).toBe("markdown");
    expect(markdownRendererMode("linux", {})).toBe("markdown");
    expect(markdownRendererMode("win32", { VESICLE_MARKDOWN_RENDERER: "markdown" })).toBe("markdown");
    expect(markdownRendererMode("linux", { VESICLE_MARKDOWN_RENDERER: "plain" })).toBe("plain");

    expect(renderMarkdownPlainText([
      "## Heading",
      "",
      "**Bold** and `code` with [link](https://example.com)",
      "- [x] Done",
      "```ts",
      "const value = 1;",
      "```",
    ].join("\n"))).toBe([
      "Heading",
      "",
      "Bold and code with link (https://example.com)",
      "- [x] Done",
      "--- code: ts ---",
      "const value = 1;",
      "--- end code ---",
    ].join("\n"));
  });

  test("prepares footnotes, definition lists, images, and details as readable text", () => {
    const source = [
      "脚注[^1]",
      "",
      "[^1]: 脚注内容",
      "",
      "Prism ETL",
      ": 角色状态空间编译引擎",
      ": 输出 Module A / Module B",
      "",
      "![替代文本](https://example.test/image.png \"图片标题\")",
      "",
      "<details><summary>可折叠区域</summary>",
      "这是折叠内容。",
      "</details>",
    ].join("\n");

    expect(prepareMarkdownForDisplay(source)).toBe([
      "脚注［1］",
      "",
      "［1］ 脚注内容",
      "",
      "Prism ETL — 角色状态空间编译引擎",
      "  → 输出 Module A / Module B",
      "",
      "🖼 替代文本 (https://example.test/image.png)",
      "",
      "▸ 可折叠区域",
      "这是折叠内容。",
    ].join("\n"));
  });

  test("does not apply Markdown formatting extension cleanup inside fenced code", () => {
    const source = "```md\n==高亮== H~2~O :rocket:\n```\nOutside ==高亮== H~2~O :rocket:";
    expect(prepareMarkdownForDisplay(source))
      .toBe("```md\n==高亮== H~2~O :rocket:\n```\nOutside ▰ 高亮 ▰ H₂O 🚀");
  });

  test("passes backslash-escaped markdown delimiters through untouched", () => {
    expect(prepareMarkdownForDisplay("\\~5~ 是约数,\\^2^ 是上标,\\==m== 是高亮"))
      .toBe("\\~5~ 是约数,\\^2^ 是上标,\\==m== 是高亮");
    expect(prepareMarkdownForDisplay("引用 \\[1\\] 与 \\(1\\) 不再变成数学"))
      .toBe("引用 \\[1\\] 与 \\(1\\) 不再变成数学");
    expect(prepareMarkdownForDisplay("\\![图](https://e.test/a.png) 和 \\[^1] 与 \\:rocket: 原样"))
      .toBe("\\![图](https://e.test/a.png) 和 \\[^1] 与 \\:rocket: 原样");
    expect(prepareMarkdownForDisplay("\\<kbd>Ctrl\\</kbd> 保持字面"))
      .toBe("\\<kbd>Ctrl\\</kbd> 保持字面");
  });

  test("still renders math and scripts when delimiters are not escaped", () => {
    expect(prepareMarkdownForDisplay("a $x^2$ b")).toBe("a x² b");
    expect(prepareMarkdownForDisplay("\\[x^2\\]")).toBe("⟦ x² ⟧");
    expect(prepareMarkdownForDisplay("\\(x^2\\)")).toBe("x²");
    expect(prepareMarkdownForDisplay("a \\\\~5~ tail")).toBe("a \\\\₅ tail");
  });

  test("plain-text rendering decodes escapes instead of stripping escaped markers", () => {
    expect(renderMarkdownPlainText("a \\~ b")).toBe("a ~ b");
    expect(renderMarkdownPlainText("\\*x\\* 与 \\*\\*x\\*\\* 保留标记"))
      .toBe("*x* 与 **x** 保留标记");
    expect(renderMarkdownPlainText("\\~~x~~ 与 `a\\` 不成对"))
      .toBe("~~x~~ 与 `a` 不成对");
    expect(renderMarkdownPlainText("\\# h、\\> q、\\- [ ] t、a \\\\ b"))
      .toBe("# h、> q、- [ ] t、a \\ b");
    expect(renderMarkdownPlainText("see \\[1\\] here")).toBe("see [1] here");
    expect(renderMarkdownPlainText("\\~5~ sub")).toBe("~5~ sub");

    expect(renderArtifactMarkdownPreview("\\*x\\* 与 a \\~ b")).toBe("*x* 与 a ~ b");
  });

});
