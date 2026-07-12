export const permissionModes = ["MANUAL", "INERTIA", "MOMENTUM", "YOLO"] as const;

export type PermissionMode = (typeof permissionModes)[number];

export type PermissionClass = "observe" | "mutate" | "arbitrary_exec" | "interaction";

export type PermissionPolicyDecision = "allow" | "ask";

export type PermissionDecisionSource = "policy" | "user" | "cli_override";

export type PermissionResolution =
  | {
      decision: "allow_once";
      resolvedAt: string;
    }
  | {
      decision: "reject";
      feedback?: string;
      resolvedAt: string;
    };

export type ProcessExecutionPlan = {
  command: string;
  cwd: ".";
  shell: "posix-sh" | "powershell";
  timeoutMs: number;
  envPolicyVersion: number;
};

export type PermissionRequest = {
  id: string;
  sessionId: string;
  toolCallId: string;
  toolName: string;
  arguments: string;
  permissionClass: Exclude<PermissionClass, "interaction">;
  mode: PermissionMode;
  createdAt: string;
  executionPlan?: ProcessExecutionPlan;
  planHash?: string;
  agent?: {
    runId: string;
    handle: string;
    parentSessionId: string;
  };
};

export type PermissionRuntimeOptions = {
  mode: PermissionMode;
  /** True only when the process was launched with --dangerously-skip-permissions. */
  dangerouslySkipPermissions?: boolean;
  /** User-level host capability opt-in; the dangerous CLI override also enables it. */
  shellExecEnabled?: boolean;
};

export const defaultPermissionRuntime: PermissionRuntimeOptions = {
  mode: "MOMENTUM",
};
