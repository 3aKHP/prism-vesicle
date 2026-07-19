import type { ProcessToolEvent } from "../tools";
import type { ResumedMessage } from "./store";
import type { SessionRecord } from "./record-model";

export function repairProviderHistory(messages: ResumedMessage[], records: SessionRecord[], preservedCallIds: Set<string>): void {
  applyBackgroundProcessCompletions(messages, records);
  appendIndeterminateProcessResults(messages, records);
  appendDanglingToolResults(messages, preservedCallIds);
}

function applyBackgroundProcessCompletions(messages: ResumedMessage[], records: SessionRecord[]): void {
  const completed = new Map<string, ProcessToolEvent>();
  for (const record of records) {
    if (record.metadata?.kind !== "background-process-completed") continue;
    const toolCallId = record.metadata.parentToolCallId;
    const processEvent = record.metadata.processEvent as ProcessToolEvent | undefined;
    if (typeof toolCallId === "string" && processEvent?.kind === "process_exec") completed.set(toolCallId, processEvent);
  }
  for (const message of messages) {
    if (message.role !== "tool" || !message.toolCallId) continue;
    const processEvent = completed.get(message.toolCallId);
    if (processEvent) message.toolProcessEvent = processEvent;
  }
}

function appendIndeterminateProcessResults(messages: ResumedMessage[], records: SessionRecord[]): void {
  const finishedRequestIds = new Set<string>();
  const answeredToolCallIds = new Set(messages.flatMap((message) => message.toolCallId ? [message.toolCallId] : []));
  for (const record of records) {
    if (record.role !== "tool") continue;
    const requestId = record.metadata?.permissionRequestId;
    if (typeof requestId === "string") finishedRequestIds.add(requestId);
  }
  for (const record of records) {
    if (record.metadata?.kind !== "process-started") continue;
    const requestId = record.metadata.requestId;
    const toolCallId = record.metadata.toolCallId;
    if (typeof requestId !== "string" || typeof toolCallId !== "string") continue;
    if (finishedRequestIds.has(requestId) || answeredToolCallIds.has(toolCallId)) continue;
    messages.push({ role: "tool", toolCallId, toolOk: false, kind: "process-indeterminate", content: JSON.stringify({ ok: false, result: "The approved shell process started before Vesicle stopped, but no completion record exists. Its side effects are indeterminate and the command was not replayed." }) });
    answeredToolCallIds.add(toolCallId);
  }
}

function appendDanglingToolResults(messages: ResumedMessage[], preservedCallIds: Set<string>): void {
  const answeredToolCallIds = new Set(messages.flatMap((message) => message.role === "tool" && message.toolCallId ? [message.toolCallId] : []));
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.role !== "assistant" || !message.toolCalls) continue;
    const dangling = message.toolCalls.filter((call) => !answeredToolCallIds.has(call.id) && !preservedCallIds.has(call.id));
    if (dangling.length === 0) continue;
    const synthetic: ResumedMessage[] = dangling.map((call) => ({ role: "tool", toolCallId: call.id, toolOk: false, kind: "tool-interrupted", content: JSON.stringify({ ok: false, result: "This tool call was not resolved with a durable result before Vesicle stopped. It was not replayed because its side effects may be indeterminate." }) }));
    messages.splice(index + 1, 0, ...synthetic);
    index += synthetic.length;
  }
}
