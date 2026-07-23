import type { AgentMetadata } from "../core/agents/types";
import type { SessionSummary } from "../core/session/store";
import type { Message, SessionPickerState } from "./types";

type StartupControllerOptions = {
  dangerouslySkipPermissions: boolean;
  initialResume: boolean;
  refreshArtifacts: () => Promise<unknown>;
  recoverInterruptedAgents: () => Promise<AgentMetadata[]>;
  notifyContinuation: (sessionId: string) => Promise<void>;
  refreshMcpStatus: () => Promise<void>;
  loadPermissionSettings: () => Promise<void>;
  loadProviderConfig: () => Promise<void>;
  setProviderConfigReady: (ready: boolean) => void;
  listSessions: () => Promise<SessionSummary[]>;
  setResumableSessions: (sessions: SessionSummary[]) => void;
  setSessionPicker: (state: SessionPickerState | null) => void;
  setMessages: (value: Message[] | ((current: Message[]) => Message[])) => void;
  setStatus: (status: string) => void;
  reportError: (error: unknown) => void;
};

export function createStartupController(options: StartupControllerOptions) {
  async function start(): Promise<void> {
    const tasks: Promise<unknown>[] = [
      reportFailure(options.refreshArtifacts()),
      recoverInterruptedAgents(),
      reportFailure(options.refreshMcpStatus()),
      loadProviderConfig(),
      discoverSessions(),
    ];
    if (!options.dangerouslySkipPermissions) tasks.push(reportFailure(options.loadPermissionSettings()));
    await Promise.all(tasks);
  }

  async function recoverInterruptedAgents(): Promise<void> {
    try {
      const recovered = await options.recoverInterruptedAgents();
      if (recovered.length === 0) return;
      options.setMessages((current) => [...current, {
        role: "system",
        content: `Recovered ${recovered.length} interrupted SubAgent${recovered.length === 1 ? "" : "s"}; foreground tool calls were closed and background failures will be delivered when their parent sessions resume.`,
      }]);
      await Promise.all(recovered
        .filter((entry) => entry.mode === "background")
        .map((agent) => options.notifyContinuation(agent.parentSessionId).catch(options.reportError)));
    } catch (error) {
      options.reportError(error);
    }
  }

  async function loadProviderConfig(): Promise<void> {
    try {
      await options.loadProviderConfig();
    } catch (error) {
      options.setProviderConfigReady(true);
      options.reportError(error);
    }
  }

  async function discoverSessions(): Promise<void> {
    try {
      const sessions = await options.listSessions();
      options.setResumableSessions(sessions);
      if (options.initialResume) {
        if (sessions.length > 0) {
          options.setSessionPicker({ sessions, selected: 0 });
          options.setStatus("choose a session to resume");
        } else {
          options.setMessages((current) => [...current, { role: "system", content: "No existing sessions found." }]);
        }
        return;
      }
      if (sessions.length > 0) {
        options.setMessages((current) => [...current, {
          role: "system",
          content: `Found ${sessions.length} existing session${sessions.length > 1 ? "s" : ""}. Type /resume to list and continue one, or just type a new prompt to start fresh.`,
        }]);
      }
    } catch (error) {
      options.reportError(error);
    }
  }

  async function reportFailure(operation: Promise<unknown>): Promise<void> {
    try {
      await operation;
    } catch (error) {
      options.reportError(error);
    }
  }

  return { start };
}
