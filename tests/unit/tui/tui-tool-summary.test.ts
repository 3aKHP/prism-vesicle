import { describe, expect, test } from "bun:test";
import { renderResumedToolResultSummary } from "../../../src/tui/tool-summary";

describe("TUI tool summaries (resume fallback)", () => {
  test("resumed result omits full content", () => {
    const longResult = "line one\n" + "very long file content ".repeat(40);
    const resumed = renderResumedToolResultSummary(JSON.stringify({ ok: true, result: longResult }));

    expect(resumed).toContain("ok tool:");
    expect(resumed.length).toBeLessThan(150);
    expect(resumed).not.toContain(longResult);
  });

  test("marks failed results", () => {
    const resumed = renderResumedToolResultSummary(JSON.stringify({ ok: false, result: "oldText was not found." }));
    expect(resumed).toContain("failed tool:");
    expect(resumed).toContain("oldText was not found.");
  });
});
