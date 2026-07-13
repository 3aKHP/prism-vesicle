import type { SessionStore } from "../session/store";
import type { ToolResult } from "../tools";
import { processEventFromTask } from "../tools/shell";
import type { BackgroundProcessState, ProcessManager } from "../process/manager";

export function trackBackgroundProcessCompletion(
  manager: ProcessManager,
  session: SessionStore,
  result: ToolResult,
): void {
  const event = result.processEvent;
  if (result.name !== "shell_exec" || !event?.taskId || event.executionMode !== "background" || event.status !== "running") return;
  void manager.wait(event.taskId).then(async (task) => {
    await session.append({
      role: "system",
      content: `Background shell task ${task.taskId} ${task.status}.`,
      metadata: {
        kind: "background-process-completed",
        taskId: task.taskId,
        parentToolCallId: task.parentToolCallId,
        processEvent: processEventFromTask(task),
      },
    });
  }).catch(() => undefined);
}

export function renderBackgroundProcessNotifications(tasks: BackgroundProcessState[]): string {
  const blocks = tasks.map((task) => {
    const output = [task.stdoutTail, task.stderrTail].filter(Boolean).join("\n").trim();
    return [
      "[background_shell]",
      `taskId: ${task.taskId}`,
      `status: ${task.status}`,
      ...(task.exitCode !== undefined ? [`exitCode: ${task.exitCode}`] : []),
      `command: ${task.plan.command}`,
      ...(output ? ["outputTail:", output] : []),
      "[/background_shell]",
    ].join("\n");
  });
  return `Background shell update${tasks.length === 1 ? "" : "s"}:\n\n${blocks.join("\n\n")}`;
}
