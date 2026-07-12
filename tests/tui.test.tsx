import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { App, contextUsageTelemetryLine, footerLine, latestTurnUsage, sessionUsageTelemetryLine, sumSessionUsage, turnUsageTelemetryLine } from "../src/tui/app";
import { GatePrompt, gateComposerIsActive, gateOptionLine, gateSummaryLineBudget, sanitizeGateLabel, wrapGateSummary } from "../src/tui/GatePrompt";
import { QuestionPrompt, optionLine, questionComposerIsActive, questionPanelMinHeight } from "../src/tui/QuestionPrompt";
import { resolveTuiLayout } from "../src/tui/layout";
import { prepareMarkdownForDisplay, renderMarkdownPlainText } from "../src/tui/markdown-display";
import { renderComposerLines } from "../src/tui/PromptComposer";
import { ArtifactCard, renderArtifactMarkdownPreview } from "../src/tui/widgets/ArtifactCard";
import { markdownRendererMode } from "../src/tui/widgets/MarkdownContent";
import { Sidebar, artifactSidebarLine, mcpSidebarLines } from "../src/tui/views/Sidebar";
import { RewindPicker, rewindPickerPanelHeight } from "../src/tui/RewindPicker";
import { sharedSyntaxStyle } from "../src/tui/theme";
import { PermissionPrompt } from "../src/tui/PermissionPrompt";
import { YoloPrompt } from "../src/tui/YoloPrompt";

describe("TUI", () => {
  test("registers shared markdown and code syntax styles", () => {
    const names = sharedSyntaxStyle.getRegisteredNames();
    expect(names).toContain("markup.heading.2");
    expect(names).toContain("markup.strong");
    expect(names).toContain("keyword");
    expect(names).toContain("string");
    expect(names).toContain("comment");
  });

  test("renders a readable balanced shell at 100 columns", async () => {
    const setup = await testRender(() => <App />, { width: 100, height: 28 });
    await setup.flush();
    const frame = setup.captureCharFrame();
    setup.renderer.destroy();

    expect(frame).toContain("Prism Vesicle");
    expect(frame).toContain("Workspace");
    expect(frame).toContain("Messages");
    expect(frame).not.toContain("Output / Validation");
    // Initial system notice should render as plain text (not the old role> prefix).
    expect(frame).toContain("Ready. Enter one Prism");
    expect(frame).not.toContain("system>");
    // Input bar present; provider registry loads asynchronously before the first send.
    expect(frame).toContain("Loading provider config");
  });

  test("renders the sidebar and telemetry footer at wide width (no activity pane)", async () => {
    const setup = await testRender(() => <App />, { width: 124, height: 28 });
    await setup.flush();
    const frame = setup.captureCharFrame();
    setup.renderer.destroy();

    expect(frame).toContain("Workspace");
    expect(frame).toContain("Messages");
    // The former right-hand Activity / Artifacts pane was removed in the TUI
    // rewrite; agent-loop detail now folds into the stream. A bottom telemetry
    // footer carries the provider/model/key connection line instead.
    expect(frame).not.toContain("Activity / Artifacts");
    expect(frame).toContain("key missing");
  });

  test("formats turn and session usage telemetry for the footer", () => {
    expect(turnUsageTelemetryLine({
      inputTokens: 18200,
      outputTokens: 1400,
      cachedInputTokens: 12000,
      contextInputTokens: 18200,
    })).toBe("turn ↑18.2k ↓1.4k ↻ 12.0k");
    expect(contextUsageTelemetryLine({
      inputTokens: 18200,
      outputTokens: 1400,
      cachedInputTokens: 12000,
      contextInputTokens: 18200,
    }, { contextWindow: 1_000_000 })).toBe("ctx 18.2k/1.0M 2%");

    const wideFooter = footerLine("deepseek", "reasoner", true, 160, {
      inputTokens: 18200,
      outputTokens: 1400,
      cachedInputTokens: 12000,
      contextInputTokens: 18200,
    }, {
      inputTokens: 42000,
      outputTokens: 6200,
      cachedInputTokens: 18000,
      contextInputTokens: 42000,
    }, { contextWindow: 1_000_000 });
    expect(wideFooter).toContain("deepseek/reasoner · key ok · turn ↑18.2k ↓1.4k ↻ 12.0k · session ↑42.0k ↓6.2k ↻ 18.0k");
    expect(wideFooter.endsWith("ctx 18.2k/1.0M 2%")).toBe(true);
    expect(/↻ 18\.0k {4,}ctx/.test(wideFooter)).toBe(true);

    expect(footerLine("deepseek", "reasoner", true, 58, {
      inputTokens: 18200,
      outputTokens: 1400,
      cachedInputTokens: 12000,
      contextInputTokens: 18200,
    }, {
      inputTokens: 42000,
      outputTokens: 6200,
      cachedInputTokens: 18000,
      contextInputTokens: 42000,
    }, { contextWindow: 1_000_000 }).endsWith("ctx 18.2k/1.0M 2%")).toBe(true);
  });

  test("aggregates logical turn usage for the footer without double-counting tool-loop context", () => {
    expect(sessionUsageTelemetryLine({
      inputTokens: 42000,
      outputTokens: 6200,
      cachedInputTokens: 18000,
      contextInputTokens: 42000,
    })).toBe("session ↑42.0k ↓6.2k ↻ 18.0k");

    const messages = [
      {
        role: "user" as const,
        content: "first prompt",
      },
      {
        role: "assistant" as const,
        content: "first",
        usage: { inputTokens: 500, outputTokens: 50, contextInputTokens: 500, cacheReadInputTokens: 100, reasoningTokens: 10, effectiveTokens: 450 },
      },
      {
        role: "user" as const,
        content: "second prompt",
      },
      {
        role: "assistant" as const,
        content: "second tool call",
        usage: { inputTokens: 1000, outputTokens: 100, contextInputTokens: 1000, cacheReadInputTokens: 300, reasoningTokens: 20, effectiveTokens: 800 },
      },
      {
        role: "tool" as const,
        content: "{}",
      },
      {
        role: "tool" as const,
        content: "subagent result",
        kind: "subagent-result",
        usage: { inputTokens: 300, outputTokens: 30, cacheReadInputTokens: 50 },
      },
      {
        role: "assistant" as const,
        content: "second final",
        usage: { inputTokens: 2000, outputTokens: 200, contextInputTokens: 2000, cacheHitInputTokens: 500, reasoningTokens: 30, effectiveTokens: 1700 },
      },
      {
        role: "user" as const,
        content: "[engine_handoff]\nSource: model_request\n[/engine_handoff]",
        kind: "engine-handoff",
      },
    ];

    expect(sumSessionUsage(messages)).toEqual({
      inputTokens: 2800,
      outputTokens: 380,
      cachedInputTokens: 650,
      contextInputTokens: 2000,
    });
    expect(latestTurnUsage(messages)).toEqual({
      inputTokens: 2300,
      outputTokens: 330,
      cachedInputTokens: 550,
      contextInputTokens: 2000,
    });
  });

  test("renders structure-preserving artifact cards in the message stream", async () => {
    const setup = await testRender(() => (
      <ArtifactCard
        path="workspace/cards/mira.md"
        content="## Biography\n\nA structured preview."
        truncated={true}
      />
    ), { width: 80, height: 10 });
    await setup.flush();
    const frame = setup.captureCharFrame();
    setup.renderer.destroy();

    expect(frame).toContain("workspace/cards/mira.md");
    expect(frame).toContain("Biography");
    expect(frame).not.toContain("## Biography");
    expect(frame).toContain("Preview truncated");
  });

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

  test("prompt composer soft-wraps long input instead of truncating it", () => {
    const rendered = renderComposerLines("abcdefghijkl", 12, "placeholder", 5, 4, true);

    expect(rendered.map((line) => `${line.prefix}${line.cursor ? line.cursorChar : ""}${line.suffix}`))
      .toEqual(["abcde", "fghij", "kl "]);
    expect(rendered.some((line) => line.prefix.includes("...") || line.suffix.includes("..."))).toBe(false);
  });

  test("prompt composer wraps long text after an explicit newline", () => {
    const rendered = renderComposerLines("one\nabcdefghijkl", 16, "placeholder", 5, 5, true);

    expect(rendered.map((line) => `${line.prefix}${line.cursor ? line.cursorChar : ""}${line.suffix}`))
      .toEqual(["one", "abcde", "fghij", "kl "]);
  });

  test("prompt composer keeps the cursor within a full-width visual line", () => {
    const rendered = renderComposerLines("abcde", 5, "placeholder", 5, 2, true);

    expect(rendered.map((line) => `${line.prefix}${line.cursor ? line.cursorChar : ""}${line.suffix}`))
      .toEqual(["abcde"]);
  });

  test("prompt composer follows the cursor when wrapped input exceeds visible height", () => {
    const rendered = renderComposerLines("abcdefghijklmnop", 16, "placeholder", 4, 2, true);

    expect(rendered.map((line) => `${line.prefix}${line.cursor ? line.cursorChar : ""}${line.suffix}`))
      .toEqual(["⋯ kl", "mnop"]);
  });

  test("does not apply Markdown formatting extension cleanup inside fenced code", () => {
    const source = "```md\n==高亮== H~2~O :rocket:\n```\nOutside ==高亮== H~2~O :rocket:";
    expect(prepareMarkdownForDisplay(source))
      .toBe("```md\n==高亮== H~2~O :rocket:\n```\nOutside ▰ 高亮 ▰ H₂O 🚀");
  });

  test("groups sidebar artifacts by fixed root without repeating root prefixes", async () => {
    const setup = await testRender(() => (
      <Sidebar
        status="ready"
        reasoningMode="collapsed"
        sessionPath=".vesicle/sessions/example.jsonl"
        mcp={{
          loading: false,
          configured: true,
          enabled: true,
          servers: [{ id: "prts_wiki", enabled: true, connected: true, toolCount: 23 }],
        }}
        artifacts={[
          { path: "workspace/cards/mira.md" },
          { path: "reports/audit.md" },
        ]}
        selectedArtifactPath="workspace/cards/mira.md"
        width={30}
      />
    ), { width: 30, height: 28 });
    await setup.flush();
    const frame = setup.captureCharFrame();
    setup.renderer.destroy();

    expect(frame).toContain("workspace/");
    expect(frame).toContain("MCP");
    expect(frame).toContain("prts_wiki: 23 tools");
    expect(frame).toContain("1. cards/mira.md");
    expect(frame).toContain("novels/");
    expect(frame).toContain("reports/");
    expect(frame).toContain("2. audit.md");
    expect(frame).toContain("test_runs/");
  });

  test("sidebar artifact rows spend their width on the path within a fixed root", () => {
    expect(artifactSidebarLine("workspace/characters/very-long-character-name.md", "workspace", 3, 22))
      .toBe("3. characte...-name.md");
  });

  test("sidebar MCP lines summarize connection state without endpoint details", () => {
    expect(mcpSidebarLines({ loading: true, configured: false, enabled: false, servers: [] }, 20))
      .toEqual([{ text: "loading", ok: true }]);
    expect(mcpSidebarLines({ loading: false, configured: false, enabled: false, servers: [] }, 20))
      .toEqual([{ text: "not configured", ok: true }]);
    expect(mcpSidebarLines({
      loading: false,
      configured: true,
      enabled: true,
      servers: [{ id: "prts_wiki", enabled: true, connected: true, toolCount: 23 }],
    }, 30)).toEqual([{ text: "prts_wiki: 23 tools", ok: true }]);
    expect(mcpSidebarLines({
      loading: false,
      configured: true,
      enabled: true,
      servers: [{ id: "github", enabled: true, connected: false, toolCount: 0, error: "HTTP 401 https://example.test" }],
    }, 30)).toEqual([{ text: "github: error", ok: false }]);
  });

  test("renders a usable stop gate panel at 100 columns", async () => {
    const setup = await testRender(() => (
      <GatePrompt
        gate={{
          gate: "blueprint-confirmation",
          summary: "Target Concept: 测试角色\nArchetype: Mirror\nCore Desire: 被理解",
        }}
        focused="confirm"
        feedbackMode={null}
        feedback=""
        width={100}
        maxSummaryLines={3}
      />
    ), { width: 100, height: 10 });
    await setup.flush();
    const frame = setup.captureCharFrame();
    setup.renderer.destroy();

    expect(frame).toContain("Stop Gate: blueprint-confirmation");
    expect(frame).toContain("Target Concept: 测试角色");
    expect(frame).toContain(">1. Confirm");
  });

  test("renders the full shell permission command and host-authority warning", async () => {
    const command = "printf 'one' && printf 'two'";
    const setup = await testRender(() => (
      <PermissionPrompt
        request={{
          id: "permission-1",
          sessionId: "session",
          toolCallId: "call",
          toolName: "shell_exec",
          arguments: JSON.stringify({ command }),
          permissionClass: "arbitrary_exec",
          mode: "MOMENTUM",
          createdAt: new Date().toISOString(),
          executionPlan: { command, cwd: ".", shell: "posix-sh", timeoutMs: 120000, envPolicyVersion: 1 },
          planHash: "hash",
        }}
        focused="confirm"
        feedbackMode={null}
        feedback=""
        feedbackCursor={0}
        width={100}
      />
    ), { width: 100, height: 10 });
    await setup.flush();
    const frame = setup.captureCharFrame();
    setup.renderer.destroy();
    expect(frame).toContain("HOST COMMAND");
    expect(frame).toContain(command);
    expect(frame).toContain("host-user authority");
  });

  test("renders the second YOLO danger confirmation", async () => {
    const setup = await testRender(() => <YoloPrompt stage={2} focused="confirm" width={100} />, { width: 100, height: 8 });
    await setup.flush();
    const frame = setup.captureCharFrame();
    setup.renderer.destroy();
    expect(frame).toContain("DANGER · Enable YOLO (2/2)");
    expect(frame).toContain("Enable YOLO for this process");
    expect(frame).toContain("Rewind cannot guarantee recovery");
  });

  test("warns when a rewind checkpoint was tainted by shell_exec", async () => {
    const point = {
      uuid: "user-1",
      parentUuid: null,
      content: "run shell",
      timestamp: new Date().toISOString(),
      branchHeadUuid: "head",
      checkpointTainted: true as const,
    };
    const setup = await testRender(() => <RewindPicker state={{
      points: [point],
      selected: 0,
      target: point,
      restoreSelected: 0,
      summaryFeedback: "",
      summaryCursor: 0,
      busy: false,
    }} width={80} />, { width: 80, height: 12 });
    await setup.flush();
    const frame = setup.captureCharFrame();
    setup.renderer.destroy();
    expect(frame).toContain("ran shell_exec");
    expect(frame).toContain("may not be restored");
  });

  test("renders request_confirmation reject input without overlapping summary and confirm rows", async () => {
    const setup = await testRender(() => (
      <GatePrompt
        gate={{
          gate: "blueprint-confirmation",
          summary: [
            "Target Concept: 一个很长的蓝图预览",
            "Archetype: Mirror",
            "Core Desire: 被理解",
            "Topology Notes: should be hidden behind ellipsis",
          ].join("\n"),
        }}
        focused="reject"
        feedbackMode={null}
        feedback=""
        width={80}
        maxSummaryLines={gateSummaryLineBudget(3, true)}
      />
    ), { width: 80, height: 9 });
    await setup.flush();
    const frame = setup.captureCharFrame();
    setup.renderer.destroy();

    const lines = frame.split("\n");
    const ellipsisLine = lines.findIndex((line) => line.includes("..."));
    const confirmLine = lines.findIndex((line) => line.includes("1. Confirm"));
    const rejectLine = lines.findIndex((line) => line.includes(">2. Reject"));
    const inputLine = lines.findIndex((line) => line.includes("✎"));

    expect(ellipsisLine).toBeGreaterThan(-1);
    expect(confirmLine).toBeGreaterThan(ellipsisLine);
    expect(rejectLine).toBeGreaterThan(confirmLine);
    expect(inputLine).toBeGreaterThan(rejectLine);
    expect(lines[confirmLine]).not.toContain("...");
    expect(lines[confirmLine]).not.toContain("Core Desire");
  });

  test("renders the rewind message list and current virtual row at 80 columns", async () => {
    const setup = await testRender(() => (
      <RewindPicker
        width={80}
        state={{
          points: [{
            uuid: "user-1",
            parentUuid: "root",
            branchHeadUuid: "head",
            content: "Create the character card",
            timestamp: new Date().toISOString(),
            diffStats: { filesChanged: ["workspace/card.md"], insertions: 4, deletions: 1 },
          }],
          selected: 1,
          restoreSelected: 0,
          summaryFeedback: "",
          summaryCursor: 0,
          busy: false,
        }}
      />
    ), { width: 80, height: 10 });
    await setup.flush();
    const frame = setup.captureCharFrame();
    setup.renderer.destroy();

    expect(frame).toContain("Rewind");
    expect(frame).toContain("Create the character card");
    expect(frame).toContain("1 file +4 -1");
    expect(frame).toContain(">(current)");
  });

  test("reserves enough height for rewind file-restore warnings", async () => {
    const state = {
      points: [],
      selected: 0,
      target: {
        uuid: "user-1",
        parentUuid: "root",
        branchHeadUuid: "head",
        content: "Rewrite the scenario card",
        timestamp: new Date().toISOString(),
        diffStats: { filesChanged: ["workspace/scenario.md"], insertions: 8, deletions: 2 },
      },
      restoreSelected: 4,
      summaryFeedback: "",
      summaryCursor: 0,
      busy: false,
    };

    expect(rewindPickerPanelHeight(state)).toBe(14);
    expect(resolveTuiLayout(100, 24, false, true, 9, rewindPickerPanelHeight(state), rewindPickerPanelHeight(state)).bottomHeight).toBe(14);

    const setup = await testRender(() => (
      <RewindPicker
        width={100}
        state={state}
      />
    ), { width: 100, height: 14 });
    await setup.flush();
    const frame = setup.captureCharFrame();
    setup.renderer.destroy();

    expect(frame).toContain(">Never mind");
    expect(frame).toContain("Rewinding does not affect files edited manually outside Vesicle tools.");
    expect(frame).toContain("↑/↓ choose");
  });

  test("renders stop gate markdown summaries instead of raw markdown markers", async () => {
    const setup = await testRender(() => (
      <GatePrompt
        gate={{
          gate: "blueprint-confirmation",
          summary: "**Target Concept:** 测试角色\n\n**Archetype:** Mirror",
        }}
        focused="confirm"
        feedbackMode={null}
        feedback=""
        width={100}
        maxSummaryLines={4}
      />
    ), { width: 100, height: 10 });
    await setup.flush();
    const frame = setup.captureCharFrame();
    setup.renderer.destroy();

    expect(frame).toContain("Target Concept:");
    expect(frame).toContain("Archetype:");
    expect(frame).not.toContain("**Target Concept:**");
    expect(frame).not.toContain("**Archetype:**");
  });

  test("builds stop gate options as stable single-line labels", () => {
    expect(gateOptionLine(1, "Confirm - proceed to next phase", true)).toBe(">1. Confirm - proceed to next phase");
    expect(gateOptionLine(2, "Reject - discuss or request changes", false)).toBe(" 2. Reject - discuss or request changes");
  });

  test("renders engine-switch summary option without overlapping the footer", async () => {
    expect(gateSummaryLineBudget(4, false, 1)).toBe(3);
    expect(gateSummaryLineBudget(4, true, 1)).toBe(2);

    const setup = await testRender(() => (
      <GatePrompt
        gate={{
          gate: "engine-switch",
          summary: "Current Engine: etl\nTarget Engine: runtime\n\nReason: Runtime should handle this.\n\nHandoff Summary: Cards are ready.",
          options: [
            { label: "Confirm - switch to runtime", decision: "confirm" },
            { label: "Reject - stay on etl and discuss", decision: "reject" },
          ],
        }}
        focused="confirm-summary"
        feedbackMode={null}
        feedback=""
        width={80}
        maxSummaryLines={gateSummaryLineBudget(4, false, 1)}
        showSummaryOption
      />
    ), { width: 80, height: 10 });
    await setup.flush();
    const frame = setup.captureCharFrame();
    setup.renderer.destroy();

    expect(frame).toContain("Stop Gate: engine-switch");
    expect(frame).toContain(">2. Confirm with summary - compact context first");
    expect(frame).toContain(" 3. Reject - stay on etl and discuss");
    expect(frame).toContain("↑/↓ navigate");
  });

  test("renders engine-switch reject input without overlapping summary options", async () => {
    const setup = await testRender(() => (
      <GatePrompt
        gate={{
          gate: "engine-switch",
          summary: [
            "Current Engine: etl",
            "Target Engine: runtime",
            "",
            "Reason: Runtime should handle this.",
            "",
            "Handoff Summary: Cards are ready.",
          ].join("\n"),
          options: [
            { label: "Confirm - switch to runtime", decision: "confirm" },
            { label: "Reject - stay on etl and discuss", decision: "reject" },
          ],
        }}
        focused="reject"
        feedbackMode={null}
        feedback=""
        width={80}
        maxSummaryLines={gateSummaryLineBudget(4, true, 1)}
        showSummaryOption
      />
    ), { width: 80, height: 10 });
    await setup.flush();
    const frame = setup.captureCharFrame();
    setup.renderer.destroy();

    const lines = frame.split("\n");
    const confirmLine = lines.findIndex((line) => line.includes("1. Confirm - switch to runtime"));
    const summaryLine = lines.findIndex((line) => line.includes("2. Confirm with summary"));
    const rejectLine = lines.findIndex((line) => line.includes(">3. Reject - stay on etl"));
    const inputLine = lines.findIndex((line) => line.includes("✎"));

    expect(confirmLine).toBeGreaterThan(-1);
    expect(summaryLine).toBeGreaterThan(confirmLine);
    expect(rejectLine).toBeGreaterThan(summaryLine);
    expect(inputLine).toBeGreaterThan(rejectLine);
    expect(lines[summaryLine]).not.toContain("Handoff Summary");
    expect(lines[rejectLine]).not.toContain("Handoff Summary");
  });

  test("activates the visible Reject composer without requiring Tab amend", () => {
    expect(gateComposerIsActive("reject", null)).toBe(true);
    expect(gateComposerIsActive("confirm", null)).toBe(false);
    expect(gateComposerIsActive("confirm", "confirm")).toBe(true);
    expect(gateSummaryLineBudget(4, false)).toBe(4);
    expect(gateSummaryLineBudget(4, true)).toBe(3);
  });

  test("builds question options as stable single-line labels", () => {
    expect(optionLine(1, "Narrow", "Minimum change.", true, 80)).toBe(">1. Narrow - Minimum change.");
    expect(optionLine(2, "Broad", "Include adjacent cleanup.", false, 80)).toBe(" 2. Broad - Include adjacent cleanup.");
    expect(optionLine(4, "Answer freely", "Type an open-ended answer.", false, 80)).toBe(" 4. Answer freely - Type an open-ended answer.");
  });

  test("uses the same freeform predicate for question rendering and input", () => {
    expect(questionComposerIsActive({ label: "Answer freely", description: "Type freely.", kind: "freeform" })).toBe(true);
    expect(questionComposerIsActive({ label: "Skip", description: "Continue.", kind: "skip" })).toBe(false);
    expect(questionComposerIsActive(undefined)).toBe(false);
  });

  test("reserves two rows when the selected question option is freeform", () => {
    const question = {
      header: "Scope",
      question: "Which scope?",
      options: [
        { label: "Narrow", description: "Minimum.", kind: "model" as const },
        { label: "Broad", description: "Adjacent cleanup.", kind: "model" as const },
        { label: "Rewrite", description: "Larger change.", kind: "model" as const },
        { label: "Audit", description: "Inspect only.", kind: "model" as const },
        { label: "Skip", description: "Continue.", kind: "skip" as const },
        { label: "Answer freely", description: "Type freely.", kind: "freeform" as const },
      ],
    };

    expect(questionPanelMinHeight(question, 0)).toBe(10);
    expect(questionPanelMinHeight(question, 5)).toBe(12);
    expect(resolveTuiLayout(100, 24, true, false, questionPanelMinHeight(question, 5)).bottomHeight).toBe(12);
  });

  test("renders the question open answer fallback with inline input", async () => {
    const setup = await testRender(() => (
      <QuestionPrompt
        question={{
          header: "Scope",
          question: "Which scope should I use?",
          options: [
            { label: "Narrow", description: "Minimum change.", kind: "model" },
            { label: "Broad", description: "Include adjacent cleanup.", kind: "model" },
            { label: "Skip", description: "Let the model continue.", kind: "skip" },
            { label: "Answer freely", description: "Type an open-ended answer.", kind: "freeform" },
          ],
        }}
        selected={3}
        width={100}
        freeformValue="Use the existing shape"
        freeformCursor={22}
      />
    ), { width: 100, height: 10 });
    await setup.flush();
    const frame = setup.captureCharFrame();
    setup.renderer.destroy();

    expect(frame).toContain(">4. Answer freely");
    expect(frame).toContain("Use the existing shape");
    const lines = frame.split("\n");
    const freeformOptionLine = lines.findIndex((line) => line.includes(">4. Answer freely"));
    const inputLine = lines.findIndex((line) => line.includes("Use the existing shape"));
    expect(inputLine).toBeGreaterThan(freeformOptionLine);
    expect(lines[freeformOptionLine]).not.toContain("Use the existing shape");
  });

  test("sanitizes model-provided stop gate option labels before rendering", () => {
    expect(sanitizeGateLabel("\u001b[31mConfirm\u001b[0m\r\nnow\b")).toBe("Confirm now");
  });

  test("wraps stop gate summary into real layout lines", () => {
    expect(wrapGateSummary("A\n\nB", 10)).toEqual(["A", "", "B"]);

    const wrapped = wrapGateSummary("Archetype: 天真的共鸣者 The Innocent Resonator", 24);
    expect(wrapped.length).toBeGreaterThan(1);
    expect(wrapped.join("")).toBe("Archetype: 天真的共鸣者 The Innocent Resonator");
  });
});
