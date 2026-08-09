import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resolvePermission, runPrompt } from "../../../src/core/agent-loop/run";
import { listRewindPoints } from "../../../src/core/rewind/service";
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
    await writeFile(join(skillRoot, "scripts", "probe.sh"), "printf 'skill-script-default-ok\\n'\nprintf 'skill-script-default-ok\\n' > workspace/skill-script-default.txt\n", "utf8");

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
    expect(await Bun.file(join(rootDir, "workspace", "skill-script-default.txt")).text()).toBe("skill-script-default-ok\n");
    expect(records.some((record) => record.metadata?.kind === "permission-request"
      && (record.metadata.request as { toolName?: string } | undefined)?.toolName === "run_skill_script")).toBe(false);
    expect((await listRewindPoints(rootDir, result.sessionId))[0]?.checkpointTainted).toBe(true);
  });

  test.skipIf(process.platform === "win32")("approved Skill scripts taint the rewind checkpoint", async () => {
    const rootDir = await createPromptRoot();
    const skillRoot = join(rootDir, ".agents", "skills", "alpha");
    await mkdir(join(skillRoot, "scripts"), { recursive: true });
    await writeFile(join(skillRoot, "SKILL.md"), [
      "---",
      "name: alpha",
      "description: Exercise approved Skill-script checkpoint taint.",
      "---",
      "",
      "# Alpha",
      "",
      "Run the bundled script when requested.",
      "",
    ].join("\n"), "utf8");
    await writeFile(join(skillRoot, "scripts", "probe.sh"), "printf '%s\\n' approved-skill-script > workspace/approved-skill-script.txt\n", "utf8");

    let requestCount = 0;
    globalThis.fetch = (async () => {
      requestCount += 1;
      if (requestCount === 1) return Response.json({
        id: "chat-approved-activate",
        choices: [{ message: { content: "", tool_calls: [{
          id: "call-approved-activate",
          type: "function",
          function: { name: "activate_skill", arguments: JSON.stringify({ name: "alpha" }) },
        }] } }],
      });
      if (requestCount === 2) return Response.json({
        id: "chat-approved-run",
        choices: [{ message: { content: "", tool_calls: [{
          id: "call-approved-run",
          type: "function",
          function: { name: "run_skill_script", arguments: JSON.stringify({ skill: "alpha", path: "scripts/probe.sh" }) },
        }] } }],
      });
      return Response.json({ id: "chat-approved-done", choices: [{ message: { content: "done" } }] });
    }) as unknown as typeof fetch;

    const permission = { mode: "INERTIA" as const, shellExecEnabled: false };
    const activationPause = await runPrompt({ input: "run the approved alpha probe", rootDir, permission });
    expect(activationPause.kind).toBe("needs_permission");
    if (activationPause.kind !== "needs_permission") throw new Error("expected activation permission pause");
    const scriptPause = await resolvePermission({
      engine: "etl",
      rootDir,
      sessionId: activationPause.sessionId,
      messages: activationPause.messages,
      request: activationPause.request,
      remainingToolCalls: activationPause.remainingToolCalls,
      resolution: { decision: "allow_once", resolvedAt: new Date().toISOString() },
      permission,
    });
    expect(scriptPause.kind).toBe("needs_permission");
    if (scriptPause.kind !== "needs_permission") throw new Error("expected Skill-script permission pause");
    const result = await resolvePermission({
      engine: "etl",
      rootDir,
      sessionId: scriptPause.sessionId,
      messages: scriptPause.messages,
      request: scriptPause.request,
      remainingToolCalls: scriptPause.remainingToolCalls,
      resolution: { decision: "allow_once", resolvedAt: new Date().toISOString() },
      permission,
    });
    expect(result.kind).toBe("complete");
    expect(await Bun.file(join(rootDir, "workspace", "approved-skill-script.txt")).text()).toBe("approved-skill-script\n");
    expect((await listRewindPoints(rootDir, result.sessionId))[0]?.checkpointTainted).toBe(true);
    const records = await loadSessionRecords(rootDir, result.sessionId);
    expect(records.some((record) => record.metadata?.kind === "process-started"
      && record.metadata.toolName === "run_skill_script")).toBe(true);
  });
});
