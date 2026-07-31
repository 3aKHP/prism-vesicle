import { describe, expect, test } from "bun:test";
import type { SessionIdentity } from "../../../src/core/agent-loop/session-init";
import { createSessionIdentityCoordinator } from "../../../src/tui/session-identity-coordinator";

describe("tui: session identity coordinator", () => {
  test("/new after /skill does not reuse the resolved identity for the next skill", async () => {
    let currentSessionId: string | undefined;
    let initializationCount = 0;
    const coordinator = createSessionIdentityCoordinator({
      currentSessionId: () => currentSessionId,
      initialize: async (): Promise<SessionIdentity> => {
        initializationCount += 1;
        return {
          sessionId: `session-${initializationCount}`,
          sessionPath: `.vesicle/sessions/session-${initializationCount}.jsonl`,
        };
      },
      apply: (identity) => { currentSessionId = identity.sessionId; },
    });

    expect(await coordinator.ensure()).toBe("session-1");

    // `/new` clears both the active signal and any cached initialization.
    coordinator.reset();
    currentSessionId = undefined;

    expect(await coordinator.ensure()).toBe("session-2");
    expect(initializationCount).toBe(2);
  });

  test("concurrent skill activations share one in-flight initialization", async () => {
    let resolveIdentity!: (identity: SessionIdentity) => void;
    let initializationCount = 0;
    const coordinator = createSessionIdentityCoordinator({
      currentSessionId: () => undefined,
      initialize: () => {
        initializationCount += 1;
        return new Promise((resolve) => { resolveIdentity = resolve; });
      },
      apply: () => undefined,
    });

    const first = coordinator.ensure();
    const second = coordinator.ensure();
    resolveIdentity({ sessionId: "shared", sessionPath: ".vesicle/sessions/shared.jsonl" });

    expect(await Promise.all([first, second])).toEqual(["shared", "shared"]);
    expect(initializationCount).toBe(1);
  });
});
