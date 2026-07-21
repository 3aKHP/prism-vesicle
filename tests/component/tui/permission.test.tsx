import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { resolveTuiLayout } from "../../../src/tui/layout";
import { PermissionPrompt, permissionPanelHeight } from "../../../src/tui/PermissionPrompt";
import { ToolCard } from "../../../src/tui/widgets/ToolCard";

describe("tui: permission surfaces", () => {
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
          executionPlan: {
            command,
            cwd: ".",
            shell: "posix-sh",
            executablePath: "/bin/sh",
            runtimePolicyVersion: 2,
            timeoutMs: 120000,
            envPolicyVersion: 1,
            runInBackground: false,
          },
          planHash: "hash",
        }}
        focused="confirm"
        feedbackMode={null}
        feedback=""
        feedbackCursor={0}
        width={80}
      />
    ), { width: 80, height: permissionPanelHeight });
    await setup.flush();
    const frame = setup.captureCharFrame();
    setup.renderer.destroy();
    expect(frame).toContain("HOST COMMAND");
    expect(frame).toContain(command);
    expect(frame).toContain("host-user authority");
    expect(frame).toContain("/bin/sh");
  });

  test("bounds long permission details without hiding the decision controls", async () => {
    const command = `echo ${"非常长的命令参数".repeat(30)}`;
    const setup = await testRender(() => (
      <PermissionPrompt
        request={{
          id: "permission-long",
          sessionId: "session",
          toolCallId: "call-long",
          toolName: "shell_exec",
          arguments: JSON.stringify({ command }),
          permissionClass: "arbitrary_exec",
          mode: "MOMENTUM",
          createdAt: new Date().toISOString(),
          executionPlan: {
            command,
            cwd: ".",
            shell: "posix-sh",
            executablePath: "/bin/sh",
            runtimePolicyVersion: 2,
            timeoutMs: 120000,
            envPolicyVersion: 1,
            runInBackground: false,
          },
          planHash: "hash-long",
        }}
        focused="confirm"
        feedbackMode={null}
        feedback=""
        feedbackCursor={0}
        width={80}
      />
    ), { width: 80, height: permissionPanelHeight });
    await setup.flush();
    const frame = setup.captureCharFrame();
    setup.renderer.destroy();

    expect(frame).toContain("hidden lines");
    expect(frame).toContain("Allow once");
    expect(frame).toContain("Reject");
    expect(frame).toContain("Esc reject");
    expect(frame.split("\n").at(-2)).toContain("└");
    expect(resolveTuiLayout(80, 24, true, false, permissionPanelHeight).bottomHeight).toBe(permissionPanelHeight);
  });

  test("shares narrow permission rows between warnings, details, and reject feedback", async () => {
    const command = `echo ${"wide command ".repeat(20)}`;
    const width = 36;
    const setup = await testRender(() => (
      <PermissionPrompt
        request={{
          id: "permission-narrow",
          sessionId: "session",
          toolCallId: "call-narrow",
          toolName: "shell_exec",
          arguments: JSON.stringify({ command }),
          permissionClass: "arbitrary_exec",
          mode: "MOMENTUM",
          createdAt: new Date().toISOString(),
          executionPlan: {
            command,
            cwd: ".",
            shell: "posix-sh",
            executablePath: "/bin/sh",
            runtimePolicyVersion: 2,
            timeoutMs: 120000,
            envPolicyVersion: 1,
            runInBackground: false,
          },
          planHash: "hash-narrow",
        }}
        focused="reject"
        feedbackMode="reject"
        feedback=""
        feedbackCursor={0}
        width={width}
      />
    ), { width, height: permissionPanelHeight });
    await setup.flush();
    const frame = setup.captureCharFrame();
    setup.renderer.destroy();

    expect(frame).toContain("Permission · HOST COMMAND");
    expect(frame).toContain("hidden lines");
    expect(frame).toContain("Allow once");
    expect(frame).toContain("Reject");
    expect(frame).toContain("Esc reject");
    expect(frame.split("\n").at(-2)).toContain("└");
  });

  test("renders live shell output, elapsed time, and background task id", async () => {
    const setup = await testRender(() => (
      <ToolCard
        toolStage="call"
        toolName="shell_exec"
        toolArgs={JSON.stringify({ command: "bun test", runInBackground: true })}
        toolProcessEvent={{
          kind: "process_exec",
          taskId: "shell-1",
          executionMode: "background",
          status: "running",
          command: "bun test",
          cwd: ".",
          shell: "posix-sh",
          durationMs: 2_500,
          timedOut: false,
          aborted: false,
          stdoutBytes: 18,
          stderrBytes: 0,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutTail: "running test suite",
          stderrTail: "",
        }}
        width={100}
      />
    ), { width: 100, height: 8 });
    await setup.flush();
    const frame = setup.captureCharFrame();
    setup.renderer.destroy();
    expect(frame).toContain("● shell_exec  bun test");
    expect(frame).toContain("running test suite");
    expect(frame).toContain("Running… · shell-1 · /bin/sh · 2.5s");
  });

});
