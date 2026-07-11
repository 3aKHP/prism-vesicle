import { compactConversationFromPoint } from "../compact/service";
import type { ConversationRewind, RewindPoint } from "./service";
import type { ProviderSelection } from "../../config/providers";
import type { VesicleRequest } from "../../providers/shared/types";
import type { EngineId } from "../engine/profile";

export async function summarizeConversationFrom(options: {
  rootDir: string;
  sessionId: string;
  point: RewindPoint;
  engine: EngineId;
  providerSelection?: Partial<ProviderSelection>;
  generation?: VesicleRequest["generation"];
  feedback?: string;
  signal?: AbortSignal;
}): Promise<ConversationRewind> {
  return compactConversationFromPoint({
    rootDir: options.rootDir,
    sessionId: options.sessionId,
    point: options.point,
    engine: options.engine,
    providerSelection: options.providerSelection,
    generation: options.generation,
    instructions: options.feedback,
    signal: options.signal,
  });
}
