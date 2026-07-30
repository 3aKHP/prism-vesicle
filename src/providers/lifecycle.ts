import {
  closeAllResponsesWebSocketSessions,
  closeResponsesWebSocketSession,
} from "./openai-responses/websocket";

/** Provider-neutral lifecycle boundary used by hosts when sessions change. */
export function closeProviderSession(sessionId: string): void {
  closeResponsesWebSocketSession(sessionId);
}

/** Close process-owned provider resources during host shutdown. */
export function closeAllProviderSessions(): void {
  closeAllResponsesWebSocketSessions();
}
