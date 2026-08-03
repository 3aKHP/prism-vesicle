import { activateSkillForSession } from "../../core/skills";
import type { EngineId } from "../../core/engine/profile";

/**
 * Skill command / session-activation owner (Phase 2 / `/skill`). Owns the
 * complete host use case behind `/skill <name> [task]` and the picker: session
 * identity, branch-parent chaining, catalog activation, system-card
 * projection, and turn submission.
 *
 * Boundary: the owner receives only narrow ports — the session-identity
 * coordinator's `ensure`, the active Engine / model-limits accessors, the
 * branch-parent get/set, a system-notice sink, and turn submission. It never
 * receives the App, CommandContext, TurnControllerOptions, or a signal bundle.
 */

export type SkillActivationOptions = {
  mode: "invoke" | "context-only";
  taskText?: string;
};

export type SkillActivationOwnerPorts = {
  rootDir: string;
  /** Lazy session-identity resolution (serialized by the host coordinator). */
  sessionIdentity: { ensure: () => Promise<string> };
  activeEngine: () => EngineId;
  activeModelLimits: () => { contextWindow?: number } | undefined;
  /** The current branch head (chain point for the activation record). */
  branchParent: () => { uuid: string | null } | null;
  /** Advance the branch head after a branched activation. */
  setBranchParent: (parent: { uuid: string } | null) => void;
  /** Append a host system notice to the transcript. */
  onNotice: (card: string) => void;
  /** Submit a follow-up turn (invoke mode). */
  submitTurn: (prompt: string) => Promise<void>;
};

export function createSkillActivationOwner(options: SkillActivationOwnerPorts) {
  async function activate(name: string, opts: SkillActivationOptions): Promise<void> {
    const rootDir = options.rootDir;
    const sid = await options.sessionIdentity.ensure();
    const branchParent = options.branchParent();
    const activation = await activateSkillForSession(rootDir, process.env, sid, name, {
      profile: { id: options.activeEngine() },
      mode: opts.mode,
      ...(branchParent ? { parentUuid: branchParent.uuid } : {}),
      contextWindow: options.activeModelLimits()?.contextWindow,
    });
    if (branchParent && activation.recordUuid) options.setBranchParent({ uuid: activation.recordUuid });
    const scriptInfo = activation.scripts.length > 0
      ? ` · ${activation.scripts.length} script${activation.scripts.length > 1 ? "s" : ""}`
      : "";
    const card = activation.alreadyActive
      ? `Skill "${activation.name}" already active [${activation.scope}].`
      : `Skill "${activation.name}" activated [${activation.scope}] · ${activation.resources.length} resource${activation.resources.length === 1 ? "" : "s"}${scriptInfo}.`;
    options.onNotice(card);
    if (opts.mode === "invoke") {
      const prompt = opts.taskText ?? `Apply the ${activation.name} skill to the current context.`;
      await options.submitTurn(prompt);
    }
  }

  return { activate };
}

export type SkillActivationOwner = ReturnType<typeof createSkillActivationOwner>;
