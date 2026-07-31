import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { realpath, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { ToolCall } from "../../../src/core/tools/types";
import { executeActivateSkillTool, executeRunSkillScriptTool } from "../../../src/core/skills";
import { clearSessionActivations } from "../../../src/core/skills";
import type { ResolvedSkillCatalog } from "../../../src/core/skills";
import { configureSelfInvocation, clearSelfInvocation } from "../../../src/core/runtime/self-invocation";
import { catalogFor, loadWritten, makeScratch, writeSkill } from "./helpers";

let scratch: string;
let sessionId: string;

beforeEach(async () => {
  scratch = await makeScratch();
  sessionId = randomUUID();
});

afterEach(async () => {
  clearSessionActivations(sessionId);
  await rm(scratch, { recursive: true, force: true });
});

function call(name: string, args: unknown): ToolCall {
  return { id: `call-${randomUUID()}`, name, arguments: JSON.stringify(args) };
}

async function activeCatalog(files: Record<string, string | Uint8Array>): Promise<ResolvedSkillCatalog> {
  const catalog = catalogFor(await loadWritten(await writeSkill(scratch, "alpha", { files })));
  const activation = await executeActivateSkillTool(call("activate_skill", { name: "alpha" }), { catalog, sessionId });
  expect(activation.ok).toBe(true);
  return catalog;
}

describe("run_skill_script executor", () => {
  test.skipIf(process.platform === "win32")("executes structured argv with no shell reinterpretation", async () => {
    // Prints each argv entry on its own line, then the cwd, proving arguments
    // reach the script verbatim and the process runs from the project root.
    const catalog = await activeCatalog({
      "scripts/echo.sh": "#!/bin/sh\nprintf '%s\\n' \"$@\"\npwd\n",
    });
    const projectRoot = await makeScratch();
    try {
      const result = await executeRunSkillScriptTool(projectRoot, call("run_skill_script", {
        skill: "alpha",
        path: "scripts/echo.sh",
        args: ["one", "two words", "; echo PWNED"],
      }), { catalog, sessionId });

      expect(result.ok).toBe(true);
      expect(result.content).toContain("[skill_script name=\"alpha\" path=\"scripts/echo.sh\" interpreter=\"sh\"]");
      expect(result.content).toContain("Exit code: 0");
      const lines = result.content.split("stdout:\n")[1]!.split("\n\nstderr:")[0]!.split("\n");
      // `; echo PWNED` is one literal argument, not a shell command chain: it is
      // echoed back verbatim as a single line instead of executing.
      expect(lines.slice(0, 3)).toEqual(["one", "two words", "; echo PWNED"]);
      expect(lines[3]).toBe(await realpath(projectRoot));

      expect(result.processEvent).toMatchObject({ kind: "process_exec", executionMode: "foreground", status: "completed", exitCode: 0, cwd: "." });
      // The durable display command is skill-relative, never absolute.
      expect(result.processEvent!.command).toBe('sh alpha/scripts/echo.sh one "two words" "; echo PWNED"');
      expect(result.processEvent!.command).not.toContain(scratch);
      expect(result.skillEvent).toMatchObject({
        kind: "skill_script_exec",
        name: "alpha",
        path: "scripts/echo.sh",
        interpreter: "sh",
        args: ["one", "two words", "; echo PWNED"],
      });
      expect(JSON.stringify(result.skillEvent)).not.toContain(scratch);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === "win32")("honors the timeout and stops the process", async () => {
    const catalog = await activeCatalog({ "scripts/slow.sh": "#!/bin/sh\nsleep 30\n" });
    const result = await executeRunSkillScriptTool(scratch, call("run_skill_script", {
      skill: "alpha",
      path: "scripts/slow.sh",
      timeoutMs: 300,
    }), { catalog, sessionId });
    expect(result.ok).toBe(false);
    expect(result.content).toContain("timed out");
    expect(result.processEvent).toMatchObject({ status: "timed_out", timedOut: true });
  }, 15_000);

  test("requires prior activation", async () => {
    const catalog = catalogFor(await loadWritten(await writeSkill(scratch, "alpha", { files: { "scripts/tool.sh": "#!/bin/sh\nexit 0\n" } })));
    const result = await executeRunSkillScriptTool(scratch, call("run_skill_script", { skill: "alpha", path: "scripts/tool.sh" }), { catalog, sessionId });
    expect(result.ok).toBe(false);
    expect(result.content).toContain("not active in this session");
  });

  test("rejects non-script paths", async () => {
    const catalog = await activeCatalog({ "references/tool.sh": "#!/bin/sh\nexit 0\n" });
    const result = await executeRunSkillScriptTool(scratch, call("run_skill_script", { skill: "alpha", path: "references/tool.sh" }), { catalog, sessionId });
    expect(result.ok).toBe(false);
    expect(result.content).toContain("not a bundled script");
  });

  test("reports unknown extensions as interpreter diagnostics", async () => {
    const catalog = await activeCatalog({ "scripts/tool.rb": "puts 1\n" });
    const result = await executeRunSkillScriptTool(scratch, call("run_skill_script", { skill: "alpha", path: "scripts/tool.rb" }), { catalog, sessionId });
    expect(result.ok).toBe(false);
    expect(result.content).toContain(".sh");
    expect(result.content).toContain(".py");
    expect(result.content).toContain(".ts");
  });

  test("reports a missing interpreter without executing anything", async () => {
    const catalog = await activeCatalog({ "scripts/tool.py": "print('never runs')\n" });
    const result = await executeRunSkillScriptTool(scratch, call("run_skill_script", { skill: "alpha", path: "scripts/tool.py" }), {
      catalog,
      sessionId,
      which: () => undefined,
    });
    expect(result.ok).toBe(false);
    expect(result.content).toContain('Interpreter "python3"');
    expect(result.content).toContain("was not executed");
    expect(result.processEvent).toBeUndefined();
  });
});

describe("run_skill_script: PowerShell resolution", () => {
  test.skipIf(process.platform === "win32")("reports pwsh unavailable on non-Windows without executing", async () => {
    const catalog = await activeCatalog({ "scripts/tool.ps1": "Write-Output hi\n" });
    const result = await executeRunSkillScriptTool(scratch, call("run_skill_script", { skill: "alpha", path: "scripts/tool.ps1" }), {
      catalog,
      sessionId,
      which: () => undefined,
    });
    expect(result.ok).toBe(false);
    expect(result.content).toContain("pwsh");
    expect(result.content).toContain("was not executed");
    expect(result.processEvent).toBeUndefined();
  });

  test("includes .ps1 in the supported extensions list for unknown types", async () => {
    const catalog = await activeCatalog({ "scripts/tool.rb": "puts 1\n" });
    const result = await executeRunSkillScriptTool(scratch, call("run_skill_script", { skill: "alpha", path: "scripts/tool.rb" }), { catalog, sessionId });
    expect(result.ok).toBe(false);
    expect(result.content).toContain(".ps1");
  });
});

describe("run_skill_script: self-invocation", () => {
  const selfExe = "/resolved/vesicle-bin";
  const selfEntry = "/resolved/cli/main.ts";

  afterEach(() => {
    clearSelfInvocation();
  });

  test.skipIf(process.platform === "win32")("injects VESICLE_SELF_EXECUTABLE and ENTRYPOINT into the child only", async () => {
    configureSelfInvocation({ executablePath: selfExe, entrypoint: selfEntry });
    const catalog = await activeCatalog({ "scripts/echo-env.sh": "#!/bin/sh\nprintf '%s\\n' \"$VESICLE_SELF_EXECUTABLE\" \"$VESICLE_SELF_ENTRYPOINT\"\n" });
    const result = await executeRunSkillScriptTool(scratch, call("run_skill_script", { skill: "alpha", path: "scripts/echo-env.sh" }), { catalog, sessionId });
    expect(result.ok).toBe(true);
    expect(result.content).toContain(selfExe);
    expect(result.content).toContain(selfEntry);
  });

  test.skipIf(process.platform === "win32")("persisted events do not record absolute self-invocation paths", async () => {
    configureSelfInvocation({ executablePath: selfExe, entrypoint: selfEntry });
    const catalog = await activeCatalog({ "scripts/echo-env.sh": "#!/bin/sh\necho ok\n" });
    const result = await executeRunSkillScriptTool(scratch, call("run_skill_script", { skill: "alpha", path: "scripts/echo-env.sh" }), { catalog, sessionId });
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result.skillEvent)).not.toContain(selfExe);
    expect(JSON.stringify(result.skillEvent)).not.toContain(selfEntry);
    expect(JSON.stringify(result.processEvent)).not.toContain(selfExe);
    expect(JSON.stringify(result.processEvent)).not.toContain(selfEntry);
  });

  test("works without configured self-invocation (no env injected, script still runs)", async () => {
    clearSelfInvocation();
    // The child simply does not see the env vars; execution is unaffected.
    const catalog = await activeCatalog({ "scripts/echo-missing.sh": "#!/bin/sh\ntest -z \"$VESICLE_SELF_EXECUTABLE\" && echo absent || echo present\n" });
    const result = await executeRunSkillScriptTool(scratch, call("run_skill_script", { skill: "alpha", path: "scripts/echo-missing.sh" }), { catalog, sessionId });
    expect(result.ok).toBe(true);
    expect(result.content).toContain("absent");
  });
});
