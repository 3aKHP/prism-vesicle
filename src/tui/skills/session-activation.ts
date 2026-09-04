import { activateSkillForSession, peekSessionSkillCatalog, refreshSessionSkillCatalog, resolveEngineEligibleCatalog } from "../../core/skills";
import type { ResolvedSkillCatalog, SessionSkillCatalogRefresh } from "../../core/skills";
import type { EngineId } from "../../core/engine/profile";

/**
 * Skill command / session-activation owner (Phase 2 / `/skill`). Owns the
 * complete host use case behind `/skill <name> [task]` and the picker: session
 * identity, branch-parent chaining, catalog activation, system-card
 * projection, and turn submission. `refresh()` owns `/skill refresh`: the
 * explicit session catalog re-freeze (#308), executed without a confirmation
 * panel (typing the command is the confirmation; the operation is repeatable
 * and append-only) and reported as a changed/removed/added diff card.
 * `resolveCatalog()` owns the picker's list (#309): the engine-eligible
 * catalog read through the same freeze-then-snapshot resolution activation
 * uses, so the picker can only list Skills the session can actually activate.
 *
 * Boundary: the owner receives only narrow ports — the session-identity
 * coordinator's `ensure`, a read-only current-session accessor (the picker
 * must not create a session, so it never goes through `ensure`), the active
 * Engine / model-limits accessors, the branch-parent get/set, a system-notice
 * sink, and turn submission. It never receives the App, a command domain
 * context, TurnControllerOptions, or a signal bundle.
 */

export type SkillActivationOptions = {
  mode: "invoke" | "context-only";
  taskText?: string;
};

export type SkillActivationOwnerPorts = {
  rootDir: string;
  /** Lazy session-identity resolution (serialized by the host coordinator). */
  sessionIdentity: { ensure: () => Promise<string> };
  /** The session that already exists, if any — read-only, never ensured. */
  currentSessionId: () => string | undefined;
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

  async function refresh(): Promise<void> {
    const sid = await options.sessionIdentity.ensure();
    const result = await refreshSessionSkillCatalog({
      rootDir: options.rootDir,
      env: process.env,
      sessionId: sid,
    });
    options.onNotice(renderSkillRefreshCard(result));
  }

  /**
   * The picker's catalog, resolved read-only through the peek path (#309):
   * freeze hit, else snapshot-filtered re-resolution, else fresh — exactly
   * what `activate` would resolve, so a drift between disk and the session's
   * frozen catalog can no longer make the picker promise `Unknown skill`.
   */
  async function resolveCatalog(): Promise<ResolvedSkillCatalog> {
    const profile = { id: options.activeEngine() };
    const catalog = await peekSessionSkillCatalog(
      options.rootDir,
      process.env,
      profile,
      options.currentSessionId(),
      options.activeModelLimits()?.contextWindow,
    );
    return resolveEngineEligibleCatalog(catalog, profile);
  }

  return { activate, refresh, resolveCatalog };
}

export function renderSkillRefreshCard(result: SessionSkillCatalogRefresh): string {
  const { drift, appended } = result;
  if (!appended) {
    return drift.persisted
      ? "Skill catalog already matches the installed Skills; nothing to re-freeze."
      : "No Skills resolve under the current installation; nothing to freeze.";
  }
  const count = drift.snapshot.entries.length;
  const lines = [
    drift.persisted
      ? "Skill catalog re-frozen at the current installation content."
      : `Skill catalog frozen for this session (${count} Skill${count === 1 ? "" : "s"}).`,
  ];
  for (const event of drift.events) {
    if (event.kind === "removed") {
      lines.push(`- Removed: ${event.name} (no longer resolves under the current installation)`);
    } else {
      lines.push(
        event.mustReactivate
          ? `- Changed: ${event.name} (activate it again with /skill ${event.name})`
          : `- Changed: ${event.name}`,
      );
    }
  }
  if (drift.added.length > 0) lines.push(`- Added: ${drift.added.join(", ")}`);
  if (result.unbudgeted) {
    lines.push("Provider configuration was unavailable; the catalog was frozen without a context-window budget.");
  }
  lines.push("The updated catalog applies from the next turn; earlier activation records stay in history.");
  return lines.join("\n");
}

export type SkillActivationOwner = ReturnType<typeof createSkillActivationOwner>;
