import type { Accessor, Setter } from "solid-js";
import type { ProviderSelection } from "../config/providers";
import { ENGINE_HANDOFF_KIND, renderEngineHandoffPacket, type EngineTransition } from "../core/engine/transition";
import type { PermissionMode } from "../core/permissions";
import { createSessionStore } from "../core/session/store";
import type { ReasoningDisplayMode } from "../core/session/store";
import type { ReasoningTier, VesicleMessage } from "../providers/shared/types";
import type { Message } from "./types";
import type { GateFocusTarget } from "./GatePrompt";

export type SessionPreferencesControllerOptions = {
  rootDir: string;
  dangerouslySkipPermissions: boolean;
  sessionId: Accessor<string | undefined>;
  nextSessionParent: Accessor<{ uuid: string | null } | null>;
  setNextSessionParent: Setter<{ uuid: string | null } | null>;
  permissionMode: Accessor<PermissionMode>;
  setPermissionMode: Setter<PermissionMode>;
  setGateFocus: Setter<GateFocusTarget>;
  setYoloConfirmStage: Setter<1 | 2 | null>;
  setStatus: Setter<string>;
  setMessages: Setter<Message[]>;
  setConversation: Setter<VesicleMessage[]>;
};

export function createSessionPreferencesController(options: SessionPreferencesControllerOptions) {
  async function persistProviderSwitch(selection: ProviderSelection): Promise<void> {
    await appendHostSessionRecord({
      role: "system",
      content: `Provider switched to ${selection.provider}/${selection.model}.`,
      metadata: { kind: "provider-switch", providerId: selection.provider, model: selection.model },
    });
  }

  async function persistEngineSwitch(transition: EngineTransition): Promise<void> {
    await appendHostSessionRecord({
      role: "system",
      content: `Engine switched to ${transition.toEngine}.`,
      metadata: {
        kind: "engine-switch",
        engine: transition.toEngine,
        targetEngine: transition.toEngine,
        reason: transition.reason,
        handoffSummary: transition.handoffSummary,
        ...(transition.recommendedNextAction ? { recommendedNextAction: transition.recommendedNextAction } : {}),
        transition,
      },
    });
    const packet = renderEngineHandoffPacket(transition);
    const appended = await appendHostSessionRecord({
      role: "user",
      content: packet,
      metadata: { kind: ENGINE_HANDOFF_KIND, engine: transition.toEngine, transition },
    });
    if (appended) options.setConversation((previous) => [...previous, { role: "user", content: packet }]);
  }

  async function persistThinkingSwitch(tier: ReasoningTier | undefined): Promise<void> {
    await appendHostSessionRecord({
      role: "system",
      content: tier ? `Thinking effort switched to ${tier}.` : "Thinking effort reset to provider default.",
      metadata: { kind: "thinking-switch", reasoningTier: tier ?? null },
    });
  }

  async function persistReasoningSwitch(mode: ReasoningDisplayMode): Promise<void> {
    await appendHostSessionRecord({
      role: "system",
      content: `Reasoning display switched to ${mode}.`,
      metadata: { kind: "reasoning-switch", reasoningDisplayMode: mode },
    });
  }

  async function changePermissionMode(mode: PermissionMode): Promise<void> {
    if (mode === "YOLO" && options.permissionMode() !== "YOLO" && !options.dangerouslySkipPermissions) {
      options.setGateFocus("confirm");
      options.setYoloConfirmStage(1);
      options.setStatus("confirm YOLO permission mode");
      return;
    }
    await applyPermissionMode(mode);
  }

  async function applyPermissionMode(mode: PermissionMode): Promise<void> {
    options.setPermissionMode(mode);
    options.setStatus(`permission mode ${mode}`);
    await appendHostSessionRecord({
      role: "system",
      content: `Permission mode switched to ${mode}.`,
      metadata: { kind: "permission-mode-switch", permissionMode: mode },
    });
    options.setMessages((previous) => [...previous, {
      role: "system",
      content: mode === "YOLO"
        ? "DANGER: YOLO enabled for this process. All tool approvals are bypassed; runtime hard guards remain active."
        : `Permission mode switched to ${mode}.`,
    }]);
  }

  async function appendHostSessionRecord(record: {
    role: "system" | "user";
    content: string;
    metadata: Record<string, unknown>;
  }) {
    const id = options.sessionId();
    if (!id) return undefined;
    const branch = options.nextSessionParent();
    const store = await createSessionStore(options.rootDir, id, branch ? { parentUuid: branch.uuid } : {});
    const appended = await store.append(record);
    if (branch) options.setNextSessionParent({ uuid: appended.uuid });
    return appended;
  }

  return {
    applyPermissionMode,
    changePermissionMode,
    persistEngineSwitch,
    persistProviderSwitch,
    persistReasoningSwitch,
    persistThinkingSwitch,
  };
}
