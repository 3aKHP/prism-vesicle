import { describe, expect, test } from "bun:test";
import type { FileToolEvent } from "../src/core/tools";
import {
  annotateLineNumbers,
  buildToolBody,
  diffText,
  foldDiffLines,
  hunkHeader,
  parseToolArgs,
  processPreviewLines,
  resolveStartLine,
  toolKind,
  toolResultFooter,
  toolTarget,
} from "../src/tui/tool-render";

describe("toolKind", () => {
  test("maps known tool names", () => {
    expect(toolKind("replace_in_file")).toBe("replace");
    expect(toolKind("create_file")).toBe("create");
    expect(toolKind("create_directory")).toBe("create");
    expect(toolKind("read_file")).toBe("read");
    expect(toolKind("copy_file")).toBe("copy");
    expect(toolKind("move_directory")).toBe("move");
    expect(toolKind("list_directory")).toBe("list");
    expect(toolKind("shell_exec")).toBe("process");
    expect(toolKind("shell_output")).toBe("process");
  });

  test("unknown tools fall back", () => {
    expect(toolKind("something_else")).toBe("unknown");
  });
});

describe("resolveStartLine", () => {
  test("replace reads the first match line from fileEvent", () => {
    const event: FileToolEvent = { kind: "file_operation", operation: "replace", changed: true, matchLines: [42, 90] };
    expect(resolveStartLine("replace", event)).toBe(42);
    expect(resolveStartLine("replace")).toBeUndefined();
  });

  test("replace falls back to legacy matchLineStart for pre-rename sessions", () => {
    const legacy: FileToolEvent = { kind: "file_operation", operation: "replace", changed: true, matchLineStart: 7 };
    expect(resolveStartLine("replace", legacy)).toBe(7);
  });

  test("create/append/write start at line 1 without fileEvent", () => {
    expect(resolveStartLine("create")).toBe(1);
    expect(resolveStartLine("append")).toBe(1);
    expect(resolveStartLine("write")).toBe(1);
  });

  test("read-only / structural tools have no start line", () => {
    expect(resolveStartLine("read")).toBeUndefined();
    expect(resolveStartLine("delete")).toBeUndefined();
  });
});

describe("toolTarget", () => {
  test("path-based tools show the path", () => {
    expect(toolTarget("read_file", parseToolArgs(JSON.stringify({ path: "assets/engines/etl.yaml" }))))
      .toBe("assets/engines/etl.yaml");
  });

  test("copy/move show source → target", () => {
    const args = parseToolArgs(JSON.stringify({ sourcePath: "assets/a.md", targetPath: "workspace/a.md" }));
    expect(toolTarget("copy_file", args)).toBe("assets/a.md → workspace/a.md");
  });

  test("grep shows path + quoted pattern", () => {
    const args = parseToolArgs(JSON.stringify({ path: "source_materials", pattern: "hero" }));
    expect(toolTarget("grep_files", args)).toBe('source_materials  "hero"');
  });

  test("null args are tolerated", () => {
    expect(toolTarget("read_file", null)).toBe("");
  });
});

describe("diffText (LCS)", () => {
  test("shared context stays neutral, changes mark +/-", () => {
    const out = diffText("a\nb\nc", "a\nB\nc");
    expect(out.map((l) => `${l.kind}:${l.text}`)).toEqual([
      "ctx:a",
      "del:b",
      "add:B",
      "ctx:c",
    ]);
  });

  test("pure insertion is all-added", () => {
    expect(diffText("", "x\ny")).toEqual([
      { kind: "add", text: "x" },
      { kind: "add", text: "y" },
    ]);
  });

  test("pure deletion is all-removed", () => {
    expect(diffText("x\ny", "")).toEqual([
      { kind: "del", text: "x" },
      { kind: "del", text: "y" },
    ]);
  });
});

describe("buildToolBody", () => {
  test("replace_in_file yields a real diff", () => {
    const args = parseToolArgs(JSON.stringify({ oldText: "a\nb\nc", newText: "a\nB\nc" }));
    const body = buildToolBody("replace_in_file", args)!;
    expect(body.map((l) => l.kind)).toEqual(["ctx", "del", "add", "ctx"]);
  });

  test("create_file is all-added lines", () => {
    const args = parseToolArgs(JSON.stringify({ content: "x\ny" }));
    const body = buildToolBody("create_file", args)!;
    expect(body).toEqual([
      { kind: "add", text: "x" },
      { kind: "add", text: "y" },
    ]);
  });

  test("read-only / delete tools have no body", () => {
    expect(buildToolBody("read_file", parseToolArgs(JSON.stringify({ path: "a" })))).toBeNull();
    expect(buildToolBody("delete_file", parseToolArgs(JSON.stringify({ path: "a" })))).toBeNull();
    expect(buildToolBody("grep_files", null)).toBeNull();
  });
});

describe("foldDiffLines", () => {
  test("short bodies pass through", () => {
    const lines = [{ kind: "add" as const, text: "a" }, { kind: "add" as const, text: "b" }];
    expect(foldDiffLines(lines, 9)).toBe(lines);
  });

  test("long bodies are bounded with an elision marker", () => {
    const huge = "line\n".repeat(200);
    const body = buildToolBody("write_file", parseToolArgs(JSON.stringify({ content: huge })))!;
    const folded = foldDiffLines(body, 9);
    expect(folded.length).toBeLessThanOrEqual(10);
    const elide = folded.find((l) => l.kind === "elide");
    expect(elide).toBeTruthy();
    expect(elide!.text).toContain("more line");
  });
});

describe("toolResultFooter", () => {
  const readEvent: FileToolEvent = {
    kind: "file_operation",
    operation: "read",
    changed: false,
    lines: 42,
  };

  test("success reads structured detail from fileEvent, not the content", () => {
    const big = "x".repeat(500);
    expect(toolResultFooter("read_file", true, big, readEvent)).toBe("read · 42 lines");
  });

  test("process progress and background status remain user-visible", () => {
    const event = {
      kind: "process_exec" as const,
      taskId: "shell-1",
      executionMode: "background" as const,
      status: "running" as const,
      command: "bun test",
      cwd: "." as const,
      shell: "posix-sh" as const,
      durationMs: 1_250,
      timedOut: false,
      aborted: false,
      stdoutBytes: 12,
      stderrBytes: 4,
      stdoutTruncated: false,
      stderrTruncated: false,
      stdoutTail: "first\nsecond",
      stderrTail: "warn",
    };
    expect(toolResultFooter("shell_exec", true, "", undefined, undefined, undefined, event))
      .toBe("background shell-1 · /bin/sh · 1.3s · 16 bytes");
    expect(processPreviewLines(event)).toEqual([
      { text: "first", stderr: false },
      { text: "second", stderr: false },
      { text: "warn", stderr: true },
    ]);
  });

  test("success reads structured detail from webEvent", () => {
    expect(toolResultFooter("web_search", true, "ignored", undefined, {
      kind: "web_search",
      provider: "tavily",
      query: "state space",
      resultCount: 2,
      urls: ["https://example.com/a", "https://docs.example.org/b"],
    })).toBe("2 results · example.com, docs.example.org");

    expect(toolResultFooter("web_fetch", true, "ignored", undefined, {
      kind: "web_fetch",
      provider: "tavily",
      urls: ["https://example.com/source"],
      chars: 6000,
      truncated: true,
    })).toBe("fetched 6000 chars · truncated · example.com");

    expect(toolResultFooter("web_map", true, "ignored", undefined, {
      kind: "web_map",
      provider: "tavily",
      url: "https://docs.example.com/",
      resultCount: 3,
      urls: ["https://docs.example.com/a", "https://docs.example.com/b", "https://docs.example.com/c"],
    })).toBe("3 urls · docs.example.com");

    expect(toolResultFooter("web_crawl", true, "ignored", undefined, {
      kind: "web_crawl",
      provider: "tavily",
      url: "https://docs.example.com/",
      pageCount: 2,
      urls: ["https://docs.example.com/a", "https://docs.example.com/b"],
      chars: 12000,
      truncated: false,
    })).toBe("2 pages · 12000 chars · docs.example.com");

    expect(toolResultFooter("web_research", true, "ignored", undefined, {
      kind: "web_research",
      provider: "tavily",
      input: "Compare A and B",
      requestId: "research-1",
      sourceCount: 4,
      urls: ["https://example.com/a"],
      chars: 9000,
      truncated: true,
    })).toBe("4 sources · 9000 chars · truncated");
  });

  test("create reports bytes", () => {
    const event: FileToolEvent = { kind: "file_operation", operation: "create", changed: true, bytes: 1234 };
    expect(toolResultFooter("create_file", true, "Created x", event)).toBe("created · 1.2KB");
  });

  test("directory operations report structural outcomes", () => {
    expect(toolResultFooter("create_directory", true, "Created", {
      kind: "file_operation",
      operation: "create_directory",
      changed: true,
    })).toBe("created directory");
    expect(toolResultFooter("list_directory", true, "Listed", {
      kind: "file_operation",
      operation: "list_directory",
      changed: false,
      entryCount: 500,
      truncated: true,
    })).toBe("500 entries · truncated");
  });

  test("replace reports occurrence count", () => {
    const event: FileToolEvent = { kind: "file_operation", operation: "replace", changed: true, bytes: 100, occurrences: 2 };
    expect(toolResultFooter("replace_in_file", true, "Replaced", event)).toBe("replaced 2× · 100B");
  });

  test("single replace footer omits the line range (it lives in the diff gutter)", () => {
    const event: FileToolEvent = { kind: "file_operation", operation: "replace", changed: true, bytes: 100, occurrences: 1, matchLines: [42] };
    expect(toolResultFooter("replace_in_file", true, "Replaced", event)).toBe("replaced 1× · 100B");
  });

  test("replaceAll footer lists every affected line", () => {
    const event: FileToolEvent = { kind: "file_operation", operation: "replace", changed: true, bytes: 300, occurrences: 3, matchLines: [12, 47, 89] };
    expect(toolResultFooter("replace_in_file", true, "Replaced", event)).toBe("replaced 3× · at lines 12, 47, 89 · 300B");
  });

  test("replaceAll footer elides a long line list", () => {
    const matchLines = [1, 2, 3, 4, 5, 6, 7];
    const event: FileToolEvent = { kind: "file_operation", operation: "replace", changed: true, bytes: 700, occurrences: 7, matchLines };
    expect(toolResultFooter("replace_in_file", true, "Replaced", event)).toBe("replaced 7× · at lines 1, 2, 3, 4, 5 +2 more · 700B");
  });

  test("failure reads the error message", () => {
    expect(toolResultFooter("replace_in_file", false, "oldText was not found.", undefined))
      .toBe("failed · oldText was not found.");
  });

  test("grep reports match count", () => {
    const event: FileToolEvent = { kind: "file_operation", operation: "grep", changed: false, matches: 3, truncated: true };
    expect(toolResultFooter("grep_files", true, "...", event)).toBe("3 matches · truncated");
  });
});

describe("annotateLineNumbers", () => {
  test("seeds cursors at startLine and walks the diff", () => {
    const out = annotateLineNumbers(diffText("a\nb\nc", "a\nB\nc"), 10);
    expect(out.map((l) => [l.kind, l.oldLine, l.newLine])).toEqual([
      ["ctx", 10, 10],
      ["del", 11, undefined],
      ["add", undefined, 11],
      ["ctx", 12, 12],
    ]);
  });

  test("no startLine leaves lines unnumbered", () => {
    const diff = diffText("a", "b");
    expect(annotateLineNumbers(diff)).toEqual(diff);
  });
});

describe("hunkHeader", () => {
  test("formats a git-style header with old/new counts", () => {
    expect(hunkHeader(diffText("a\nb\nc", "a\nB\nc"), 10)).toBe("@@ -10,3 +10,3 @@");
  });

  test("omits the count for a single-line side", () => {
    expect(hunkHeader(diffText("a", "b"), 5)).toBe("@@ -5 +5 @@");
  });

  test("null when no start line is known", () => {
    expect(hunkHeader(diffText("a", "b"))).toBeNull();
  });
});
