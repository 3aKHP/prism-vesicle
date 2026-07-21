import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { runPrompt, } from "../../../src/core/agent-loop/run";
import { loadSessionSnapshot } from "../../../src/core/session/store";
import { harnessRuntime, providerTool, providerTools, restoreQualityTestState, runtimeRoot } from "./fixtures/quality-runtime";

afterEach(restoreQualityTestState);

describe("quality: artifact post-image", () => {
  test("does not let a clean completion summary pass an unchanged bad artifact", async () => {
    const root = await runtimeRoot("runtime", ["runtime-turn"]);
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      if (requests === 1) {
        return providerTool("summary-bypass-write", "write_file", {
          path: "workspace/runtime.md",
          content: "### Part 3 - Prose Content\n空气中弥漫着雨味。",
        });
      }
      if (requests === 2) {
        return providerTool("summary-bypass-gate", "request_confirmation", { gate: "runtime-turn", summary: "Review." });
      }
      return Response.json({ id: "summary-bypass-done", choices: [{ message: { content: "已完成质量修订。" } }] });
    }) as unknown as typeof fetch;

    const result = await runPrompt({
      input: "continue",
      engine: "runtime",
      rootDir: root,
      messages: [{ role: "user", content: "continue" }],
      harness: harnessRuntime(),
    });

    expect(result.kind).toBe("needs_quality_decision");
    expect(requests).toBe(3);
    expect(await readFile(join(root, "workspace", "runtime.md"), "utf8")).toContain("空气中弥漫着");
    const snapshot = await loadSessionSnapshot(root, result.sessionId);
    expect(snapshot.qualityEvents.map((event) => event.decision)).toEqual(["rewrite", "exhausted"]);
  });

  test("checks the complete replace_in_file post-image", async () => {
    const root = await runtimeRoot("runtime", ["runtime-turn"]);
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      if (requests === 1) {
        return providerTool("partial-replace-write", "write_file", {
          path: "workspace/runtime.md",
          content: "### Part 3 - Prose Content\n空气中弥漫着雨味。\n空气中弥漫着尘味。",
        });
      }
      if (requests === 2) {
        return providerTool("partial-replace-gate", "request_confirmation", { gate: "runtime-turn", summary: "Review." });
      }
      if (requests === 3) {
        return providerTool("partial-replace-one", "replace_in_file", {
          path: "workspace/runtime.md",
          oldText: "空气中弥漫着雨味。",
          newText: "雨水沿着门框滑落。",
        });
      }
      if (requests === 4) {
        return providerTool("partial-replace-second-gate", "request_confirmation", { gate: "runtime-turn", summary: "Review rewrite." });
      }
      return Response.json({ id: "partial-replace-done", choices: [{ message: { content: "已完成质量修订。" } }] });
    }) as unknown as typeof fetch;

    const result = await runPrompt({
      input: "continue",
      engine: "runtime",
      rootDir: root,
      messages: [{ role: "user", content: "continue" }],
      harness: harnessRuntime(),
    });

    expect(result.kind).toBe("needs_quality_decision");
    expect(requests).toBe(5);
    expect(await readFile(join(root, "workspace", "runtime.md"), "utf8")).toContain("空气中弥漫着尘味");
    const snapshot = await loadSessionSnapshot(root, result.sessionId);
    expect(snapshot.qualityEvents.map((event) => event.decision)).toEqual(["rewrite", "rewrite", "exhausted"]);
  });

  test("checks the complete append_file post-image", async () => {
    const root = await runtimeRoot("runtime", ["runtime-turn"]);
    await writeFile(join(root, "workspace", "runtime.md"), "### Part 3 - Prose Content\n空气中弥漫着旧纸味。\n", "utf8");
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      if (requests === 1) {
        return providerTool("clean-append", "append_file", {
          path: "workspace/runtime.md",
          content: "她把窗推开。\n",
        });
      }
      if (requests === 2) {
        return providerTool("clean-append-gate", "request_confirmation", { gate: "runtime-turn", summary: "Review." });
      }
      return Response.json({ id: "clean-append-done", choices: [{ message: { content: "已完成质量修订。" } }] });
    }) as unknown as typeof fetch;

    const result = await runPrompt({
      input: "continue",
      engine: "runtime",
      rootDir: root,
      messages: [{ role: "user", content: "continue" }],
      harness: harnessRuntime(),
    });

    expect(result.kind).toBe("needs_quality_decision");
    expect(requests).toBe(3);
    const snapshot = await loadSessionSnapshot(root, result.sessionId);
    expect(snapshot.qualityEvents.map((event) => event.decision)).toEqual(["rewrite", "exhausted"]);
  });

  test("keeps each artifact target pending until that path is clean", async () => {
    const root = await runtimeRoot("runtime", ["runtime-turn"]);
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      if (requests === 1) {
        return providerTools("two-target-write", [
          { id: "call-two-target-clean", name: "write_file", arguments: JSON.stringify({ path: "workspace/clean.md", content: "雨水沿着门框滑落。" }) },
          { id: "call-two-target-bad", name: "write_file", arguments: JSON.stringify({ path: "workspace/bad.md", content: "空气中弥漫着尘味。" }) },
        ]);
      }
      if (requests === 2) {
        return providerTool("two-target-gate", "request_confirmation", { gate: "runtime-turn", summary: "Review." });
      }
      if (requests === 3) {
        return providerTool("two-target-rewrite-clean-only", "write_file", {
          path: "workspace/clean.md",
          content: "她把窗推得更开。",
        });
      }
      if (requests === 4) {
        return providerTool("two-target-second-gate", "request_confirmation", { gate: "runtime-turn", summary: "Review rewrite." });
      }
      return Response.json({ id: "two-target-done", choices: [{ message: { content: "已完成质量修订。" } }] });
    }) as unknown as typeof fetch;

    const result = await runPrompt({
      input: "continue",
      engine: "runtime",
      rootDir: root,
      messages: [{ role: "user", content: "continue" }],
      harness: harnessRuntime(),
    });

    expect(result.kind).toBe("needs_quality_decision");
    expect(requests).toBe(4);
    expect(await readFile(join(root, "workspace", "bad.md"), "utf8")).toContain("空气中弥漫着");
    const snapshot = await loadSessionSnapshot(root, result.sessionId);
    expect(snapshot.qualityEvents.map((event) => event.decision)).toEqual(["rewrite", "exhausted"]);
  });

  test("checks a successful mutation before allowing a same-response gate", async () => {
    const root = await runtimeRoot("runtime", ["runtime-turn"]);
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      if (requests === 1) {
        return providerTools("write-and-gate", [
          { id: "call-write-and-gate-file", name: "write_file", arguments: JSON.stringify({
            path: "workspace/runtime.md",
            content: "### Part 3 - Prose Content\n空气中弥漫着雨味。",
          }) },
          { id: "call-write-and-gate-gate", name: "request_confirmation", arguments: JSON.stringify({
            gate: "runtime-turn",
            summary: "Review.",
          }) },
        ]);
      }
      if (requests === 2) {
        return providerTool("write-and-gate-replace", "replace_in_file", {
          path: "workspace/runtime.md",
          oldText: "空气中弥漫着雨味。",
          newText: "雨水沿着门框滑落。",
        });
      }
      return providerTool("write-and-gate-clean", "request_confirmation", { gate: "runtime-turn", summary: "Review rewrite." });
    }) as unknown as typeof fetch;

    const result = await runPrompt({
      input: "continue",
      engine: "runtime",
      rootDir: root,
      messages: [{ role: "user", content: "continue" }],
      harness: harnessRuntime(),
    });

    expect(result.kind).toBe("needs_user");
    expect(requests).toBe(3);
    const snapshot = await loadSessionSnapshot(root, result.sessionId, { synthesizeDanglingToolResults: false });
    expect(snapshot.qualityEvents.map((event) => event.decision)).toEqual(["rewrite", "pass"]);
  });

  test("rereads the current post-image when the file changes after a successful mutation", async () => {
    const root = await runtimeRoot("runtime", ["runtime-turn"]);
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      if (requests === 1) {
        return providerTool("external-edit-write", "write_file", {
          path: "workspace/runtime.md",
          content: "### Part 3 - Prose Content\n雨水沿着门框滑落。",
        });
      }
      if (requests === 2) {
        await writeFile(
          join(root, "workspace", "runtime.md"),
          "### Part 3 - Prose Content\n空气中弥漫着外部写入的雨味。",
          "utf8",
        );
        return providerTool("external-edit-gate", "request_confirmation", { gate: "runtime-turn", summary: "Review." });
      }
      return Response.json({ id: "external-edit-done", choices: [{ message: { content: "已完成质量修订。" } }] });
    }) as unknown as typeof fetch;

    const result = await runPrompt({
      input: "continue",
      engine: "runtime",
      rootDir: root,
      messages: [{ role: "user", content: "continue" }],
      harness: harnessRuntime(),
    });

    expect(result.kind).toBe("needs_quality_decision");
    expect(requests).toBe(3);
    const snapshot = await loadSessionSnapshot(root, result.sessionId);
    expect(snapshot.qualityEvents.map((event) => event.decision)).toEqual(["rewrite", "exhausted"]);
  });

});
