import { describe, expect, test } from "bun:test";
import {
  renderAssistantToolTurn,
  renderResumedToolResultSummary,
  renderToolCallSummary,
  renderToolResultSummary,
} from "../src/tui/tool-summary";

describe("TUI tool summaries", () => {
  test("summarizes tool-call arguments without rendering full input", () => {
    const longContent = "secret draft ".repeat(40);
    const argumentsJson = JSON.stringify({
      path: "workspace/阿橘.md",
      content: longContent,
    });

    const summary = renderToolCallSummary("write_file", argumentsJson);
    const assistantTurn = renderAssistantToolTurn("writing file", [
      { name: "write_file", arguments: argumentsJson },
    ]);

    expect(summary).toContain("write_file workspace/阿橘.md");
    expect(summary).toContain(`(${longContent.length} chars)`);
    expect(summary).not.toContain(longContent);
    expect(assistantTurn).not.toContain(longContent);
  });

  test("summarizes live and resumed tool results without dumping full output", () => {
    const longResult = "line one\n" + "very long file content ".repeat(40);
    const live = renderToolResultSummary("read_file", true, longResult);
    const resumed = renderResumedToolResultSummary(JSON.stringify({ ok: true, result: longResult }));

    expect(live).toContain("ok read_file:");
    expect(resumed).toContain("ok tool:");
    expect(live.length).toBeLessThan(150);
    expect(resumed.length).toBeLessThan(150);
    expect(live).not.toContain(longResult);
    expect(resumed).not.toContain(longResult);
  });
});
