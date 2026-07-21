import type { Command } from "./commands/types";
import { resolveCommandBusyBehavior, resolveCommandInvocation } from "./commands/dispatch";
import type { QueuedCommand } from "./input-queue";

export type CommandSubmissionHandlers = {
  execute: (raw: string) => void;
  enqueue: (command: { raw: string; commandName: string; args: string; boundary: "tool-round" | "agent-loop" }) => number;
  reject: (reason: string) => void;
};

export function routeCommandSubmission(
  raw: string,
  busy: boolean,
  commands: readonly Command[],
  handlers: CommandSubmissionHandlers,
): boolean {
  const invocation = resolveCommandInvocation(raw, commands);
  if (!busy || !invocation.command) {
    handlers.execute(raw);
    return true;
  }
  const behavior = resolveCommandBusyBehavior(invocation.command, invocation.args);
  if (behavior.kind === "immediate") {
    handlers.execute(raw);
    return true;
  }
  if (behavior.kind === "reject") {
    handlers.reject(behavior.reason);
    return false;
  }
  handlers.enqueue({
    raw,
    commandName: invocation.command.name,
    args: invocation.args,
    boundary: behavior.boundary,
  });
  return true;
}

export async function executeQueuedCommands(
  commands: QueuedCommand[],
  handlers: {
    beforeExecute?: (command: QueuedCommand) => void;
    execute: (raw: string) => Promise<void>;
    restoreNext: (command: QueuedCommand) => void;
    reportError: (error: unknown) => void;
  },
): Promise<void> {
  for (let index = 0; index < commands.length; index += 1) {
    const command = commands[index]!;
    try {
      handlers.beforeExecute?.(command);
      await handlers.execute(command.raw);
    } catch (error) {
      for (let restoreIndex = commands.length - 1; restoreIndex > index; restoreIndex -= 1) {
        handlers.restoreNext(commands[restoreIndex]!);
      }
      handlers.reportError(error);
      return;
    }
  }
}
