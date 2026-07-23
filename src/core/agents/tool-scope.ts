export const unsupportedChildToolNames = new Set([
  "request_confirmation",
  "request_engine_switch",
  "ask_user_question",
  "read_instructions",
  "update_instructions",
  "spawn_agent",
  "list_agents",
  "send_message",
  "interrupt_agent",
  "wait_agent",
  "shell_exec",
  "shell_output",
  "shell_stop",
]);

export function assertChildToolDeclaration(
  declared: readonly string[],
  availableNames: ReadonlySet<string>,
): void {
  if (declared[0] === "*") return;
  for (const name of declared) {
    if (unsupportedChildToolNames.has(name)) {
      throw new Error(`Agent profile cannot use interactive or recursive tool "${name}".`);
    }
    if (!availableNames.has(name)) throw new Error(`Agent profile declares unknown tool "${name}".`);
  }
}
