import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runPrompt } from "../../../src/core/agent-loop/run";
import { loadSessionRecords } from "../../../src/core/session/store";
import {
  configureTestProviderEnv,
  createPromptRoot,
  restoreAgentLoopTestState,
} from "./fixtures/agent-loop";

beforeEach(configureTestProviderEnv);
afterEach(restoreAgentLoopTestState);

describe("agent loop: Skill-script permission boundary", () => {
  test.skipIf(process.platform === "win32")("MOMENTUM runs an activated Skill script while shell_exec stays disabled", async () => {
    const rootDir = await createPromptRoot();
    const skillRoot = join(rootDir, ".agents", "skills", "alpha");
    await mkdir(join(skillRoot, "scripts"), { recursive: true });
    await writeFile(join(skillRoot, "SKILL.md"), [
      "---",
      "name: alpha",
      "description: Exercise the independent Skill-script permission boundary.",
      "---",
      "",
      "# Alpha",
      "",
      "Run the bundled script when requested.",
      "",
    ].join("\n"), "utf8");
    await writeFile(join(skillRoot, "scripts", "probe.sh"), "printf 'skill-script-default-ok\\n'\n", "utf8");

    const requests: Array<Record<string, unknown>> = [];
    let requestCount = 0;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      requestCount += 1;
      if (requestCount === 1) {
        return Response.json({
          id: "chat-skill-activate",
          choices: [{ message: { content: "", tool_calls: [{
            id: "call-activate-alpha",
            type: "function",
            function: { name: "activate_skill", arguments: JSON.stringify({ name: "alpha" }) },
          }] } }],
        });
      }
      if (requestCount === 2) {
        return Response.json({
          id: "chat-skill-run",
          choices: [{ message: { content: "", tool_calls: [{
            id: "call-run-alpha",
            type: "function",
            function: { name: "run_skill_script", arguments: JSON.stringify({ skill: "alpha", path: "scripts/probe.sh" }) },
          }] } }],
        });
      }
      return Response.json({ id: "chat-skill-done", choices: [{ message: { content: "done" } }] });
    }) as unknown as typeof fetch;

    const result = await runPrompt({
      input: "run the alpha probe",
      rootDir,
      permission: { mode: "MOMENTUM", shellExecEnabled: false },
    });

    expect(result.kind).toBe("complete");
    expect(requestCount).toBe(3);
    const toolNames = (((requests[0]?.tools as Array<{ function?: { name?: string } }> | undefined) ?? [])
      .map((tool) => tool.function?.name));
    expect(toolNames).toContain("run_skill_script");
    expect(toolNames).not.toContain("shell_exec");
    const records = await loadSessionRecords(rootDir, result.sessionId);
    expect(records.some((record) => record.role === "tool" && record.content.includes("skill-script-default-ok"))).toBe(true);
    expect(records.some((record) => record.metadata?.kind === "permission-request"
      && (record.metadata.request as { toolName?: string } | undefined)?.toolName === "run_skill_script")).toBe(false);
  });
});
