import { runChildAgent } from "../agents/child-runner";
import { AgentManager } from "../agents/manager";
import { AgentStore } from "../agents/store";
import type { AgentLoopEvent } from "./types";

export function createTurnAgentManager(
  rootDir: string,
  onEvent?: (event: AgentLoopEvent) => void,
): AgentManager {
  return new AgentManager(new AgentStore(rootDir), runChildAgent, { onEvent });
}
