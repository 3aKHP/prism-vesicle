import type { SessionIdentity } from "../core/agent-loop/session-init";

export type SessionIdentityCoordinatorOptions = {
  currentSessionId: () => string | undefined;
  initialize: () => Promise<SessionIdentity>;
  apply: (identity: SessionIdentity) => void;
};

/** Serializes lazy session creation and releases the resolved identity after use. */
export function createSessionIdentityCoordinator(options: SessionIdentityCoordinatorOptions) {
  let pending: Promise<SessionIdentity> | null = null;

  async function ensure(): Promise<string> {
    const current = options.currentSessionId();
    if (current) return current;
    pending ??= options.initialize();
    const initialization = pending;
    try {
      const identity = await initialization;
      options.apply(identity);
      return identity.sessionId;
    } finally {
      if (pending === initialization) pending = null;
    }
  }

  function reset(): void {
    pending = null;
  }

  return { ensure, reset };
}
