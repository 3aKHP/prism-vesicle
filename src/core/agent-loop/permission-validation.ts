import type { VesicleMessage } from "../../providers/shared/types";
import { agentToolNames } from "../agents/tools";
import type { PermissionRequest } from "../permissions";
import type { loadSessionRecords } from "../session/store";
import type { DeferredAgentPermission } from "./types";

type ValidateDurablePermissionOptions = {
  sessionId: string;
  messages: VesicleMessage[];
  request: PermissionRequest;
  deferredAgentPermissions?: DeferredAgentPermission[];
  records: Awaited<ReturnType<typeof loadSessionRecords>>;
};

export function validateDurablePermissionRequest(options: ValidateDurablePermissionOptions): void {
  if (options.request.sessionId !== options.sessionId) {
    throw new Error("Permission request session does not match the session being resumed.");
  }
  const matchesRecord = (expected: PermissionRequest) => options.records.some((record) => {
    if (record.metadata?.kind !== "permission-request") return false;
    const request = record.metadata.request as Partial<PermissionRequest> | undefined;
    return request?.id === expected.id
      && request.sessionId === expected.sessionId
      && request.toolCallId === expected.toolCallId
      && request.toolName === expected.toolName
      && request.arguments === expected.arguments;
  });
  const matchesConversation = (request: PermissionRequest) => options.messages.some((message) =>
    message.role === "assistant" && message.toolCalls?.some((candidate) =>
      candidate.id === request.toolCallId && candidate.name === request.toolName && candidate.arguments === request.arguments
    )
  );
  const alreadyResolved = options.records.some((record) =>
    record.metadata?.kind === "permission-resolution" && record.metadata.requestId === options.request.id
  );
  if (!matchesRecord(options.request) || alreadyResolved) {
    throw new Error("Permission request is missing from the active session or has already been resolved.");
  }

  const requestIds = new Set([options.request.id]);
  for (const deferred of options.deferredAgentPermissions ?? []) {
    const request = deferred.request;
    if (
      request.sessionId !== options.sessionId
      || !agentToolNames.has(request.toolName)
      || requestIds.has(request.id)
      || !matchesRecord(request)
      || !options.records.some((record) => record.metadata?.kind === "permission-resolution"
        && record.metadata.requestId === request.id
        && record.metadata.decision === deferred.resolution.decision)
      || options.records.some((record) => record.role === "tool" && record.metadata?.permissionRequestId === request.id)
      || !matchesConversation(request)
      || options.messages.some((message) => message.role === "tool" && message.toolCallId === request.toolCallId)
    ) {
      throw new Error("Deferred Agent permission batch does not match unresolved durable session state.");
    }
    requestIds.add(request.id);
  }
  if (!matchesConversation(options.request)
    || options.messages.some((message) => message.role === "tool" && message.toolCallId === options.request.toolCallId)) {
    throw new Error("Permission request does not match an unresolved tool call in this session.");
  }
}
