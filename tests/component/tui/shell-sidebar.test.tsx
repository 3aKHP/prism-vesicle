import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { App, backgroundProcessActivitySummary, headerLine, } from "../../../src/tui/app";
import { Sidebar, artifactSidebarLine, mcpSidebarLines, processSidebarLines } from "../../../src/tui/views/Sidebar";
import { backgroundProcess } from "./fixtures/tui";

describe("tui: shell and sidebar", () => {
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

  test("keeps active background shells visible in the header and sidebar", () => {
    const process = backgroundProcess("shell-1");
    expect(backgroundProcessActivitySummary([process])).toBe("1 running");
    expect(headerLine("etl", 100, undefined, "1 running")).toContain("Shell 1 running");
    expect(processSidebarLines([process], 30, "session-1")[0]?.text).toContain("shell-1 · running");
  });

  test("keeps the Shell and Effort sidebar rows separate with several background tasks", async () => {
    const processes = [
      backgroundProcess("shell-1"),
      backgroundProcess("shell-2"),
      backgroundProcess("shell-3"),
    ];
    expect(processSidebarLines(processes, 40, "session-1"))
      .toEqual([{ text: "● shell-3 · running · +2 more", color: expect.any(String), active: true }]);

    for (const terminalWidth of [80, 100]) {
      const setup = await testRender(() => (
        <Sidebar
          status="ready"
          thinkingTier="auto"
          reasoningMode="collapsed"
          sessionPath=".vesicle/sessions/example.jsonl"
          processes={processes}
          width={terminalWidth === 80 ? 24 : 30}
          artifacts={[]}
        />
      ), { width: terminalWidth, height: 28 });
      await setup.flush();
      const frame = setup.captureCharFrame();
      setup.renderer.destroy();
      const lines = frame.split("\n");
      const shellSummaryLine = lines.findIndex((line) => line.includes("shell-3"));
      const effortLine = lines.findIndex((line) => line.includes("Effort"));
      const tierLine = lines.findIndex((line) => line.includes("tier: auto"));
      const reasoningLine = lines.findIndex((line) => line.includes("reasoning: preview"));

      expect(shellSummaryLine).toBeGreaterThan(-1);
      expect(frame).toContain("+2 more");
      expect(frame).not.toContain("shell-1");
      expect(frame).not.toContain("shell-2");
      expect(effortLine).toBe(shellSummaryLine + 2);
      expect(tierLine).toBe(effortLine + 1);
      expect(reasoningLine).toBe(tierLine + 1);
    }
  });

});
