import { createSignal, type Accessor, type Setter } from "solid-js";
import {
  assertJudgeCandidateHasKey,
  defaultExperimentalQualityTimeoutMs,
  judgeCandidateHasKey,
  loadExperimentalQualitySettings,
  writeExperimentalQualitySettings,
} from "../config/quality";
import type { TuiKeyEvent } from "./decision-interaction";
import { modelOptionItems, providerOptionItems } from "./commands/options";
import type { Message, OptionItem } from "./types";
import type { ProviderRegistry } from "../config/providers";
import type { ExperimentalQualitySettings } from "../config/quality";
import type {
  QualityPickerCandidate,
  QualityPickerState,
  QualityRewriteConfirmState,
} from "./views/BottomSurface";

export type ResolvedQualityCandidate = {
  candidate: QualityPickerCandidate;
  source: "retained" | "active";
  currentTuple?: QualityPickerCandidate;
};

/**
 * Resolve the Judge candidate the picker/command will preselect. A retained
 * tuple that still resolves in the provider registry wins; otherwise the active
 * registered provider/model plus the default timeout is the visibly preselected
 * candidate. This is a UI default, never a runtime fallback.
 */
export function resolveQualityCandidate(
  settings: Pick<ExperimentalQualitySettings, "mode" | "providerAlias" | "modelId" | "judgeTimeoutMs">,
  registry: ProviderRegistry,
  activeProvider: string,
  activeModel: string,
): ResolvedQualityCandidate {
  const retained = completeQualityTuple(settings);
  if (retained && qualityTupleResolves(retained, registry)) {
    return { candidate: retained, source: "retained", currentTuple: retained };
  }
  return {
    candidate: { providerAlias: activeProvider, modelId: activeModel, judgeTimeoutMs: defaultExperimentalQualityTimeoutMs },
    source: "active",
    currentTuple: retained,
  };
}

export function completeQualityTuple(settings: Pick<ExperimentalQualitySettings, "providerAlias" | "modelId" | "judgeTimeoutMs">): QualityPickerCandidate | undefined {
  if (settings.providerAlias && settings.modelId && settings.judgeTimeoutMs !== undefined) {
    return { providerAlias: settings.providerAlias, modelId: settings.modelId, judgeTimeoutMs: settings.judgeTimeoutMs };
  }
  return undefined;
}

export function qualityTupleResolves(tuple: QualityPickerCandidate, registry: ProviderRegistry): boolean {
  const provider = registry.providers.find((entry) => entry.id === tuple.providerAlias);
  return Boolean(provider?.models.some((model) => model.id === tuple.modelId));
}

function sameCandidate(a: QualityPickerCandidate | undefined, b: QualityPickerCandidate): boolean {
  return Boolean(a) && a!.providerAlias === b.providerAlias && a!.modelId === b.modelId && a!.judgeTimeoutMs === b.judgeTimeoutMs;
}

export function createQualityPickerController(options: {
  providerRegistry: Accessor<ProviderRegistry | null>;
  ensureProviderRegistry: () => Promise<ProviderRegistry>;
  activeProvider: Accessor<string>;
  activeModel: Accessor<string>;
  setStatus: Setter<string>;
  setMessages: Setter<Message[]>;
  reportError: (error: unknown) => void;
}) {
  const [qualityPicker, setQualityPicker] = createSignal<QualityPickerState | null>(null);
  const [qualityRewriteConfirm, setQualityRewriteConfirm] = createSignal<QualityRewriteConfirmState | null>(null);
  const [qualityPickerBusy, setQualityPickerBusy] = createSignal(false);

  // Items/title are plain accessors that read the picker signal. They stay
  // reactive when read inside the TUI render's tracking scope, and they
  // recompute on demand for the controller's own key handling.
  function qualityPickerItems(): OptionItem[] {
    const picker = qualityPicker();
    const registry = options.providerRegistry();
    if (!picker) return [];
    if (picker.step === "mode") {
      return [
        { id: "off", label: "Off", detail: "No Judge requests" },
        { id: "observe", label: "Review only", detail: "Record experimental findings; no revisions" },
        { id: "rewrite", label: "Review and revise", detail: "May request up to two Engine revisions" },
        { id: "change-judge", label: "Change Judge", detail: `${picker.candidate.providerAlias}/${picker.candidate.modelId}` },
      ];
    }
    if (picker.step === "provider") return registry ? providerOptionItems(registry) : [];
    if (picker.step === "model") return registry ? modelOptionItems(registry, picker.browsingProvider ?? picker.candidate.providerAlias) : [];
    return [];
  }
  function qualityPickerTitle(): string {
    const picker = qualityPicker();
    if (!picker) return "Experimental Semantic Judge";
    if (picker.step === "mode") {
      // The exact candidate is shown in the Change Judge detail row; keep the
      // title short so it never crowds the hint at 80 columns.
      return `Experimental Semantic Judge · ${picker.currentMode}`;
    }
    if (picker.step === "provider") return "Change Judge · provider";
    return `Change Judge · model · ${picker.browsingProvider ?? picker.candidate.providerAlias}`;
  }

  function handleQualityPickerKey(key: TuiKeyEvent): boolean {
    const picker = qualityPicker();
    if (!picker) return false;
    if (qualityPickerBusy()) return true;
    if (qualityRewriteConfirm()) return true; // the confirm panel owns keys while open
    const items = qualityPickerItems();
    if (items.length === 0) return false;
    if (key.name === "up" || (key.ctrl && key.name === "p")) {
      setQualityPicker({ ...picker, selected: (picker.selected - 1 + items.length) % items.length });
      return true;
    }
    if (key.name === "down" || (key.ctrl && key.name === "n")) {
      setQualityPicker({ ...picker, selected: (picker.selected + 1) % items.length });
      return true;
    }
    if (key.name === "escape") {
      if (picker.step === "mode") {
        setQualityPicker(null);
        options.setStatus("quality settings cancelled");
      } else if (picker.step === "provider") {
        setQualityPicker({ ...picker, step: "mode", selected: modeIndexFor(picker.currentMode) });
      } else {
        const registry = options.providerRegistry();
        setQualityPicker({ ...picker, step: "provider", selected: providerIndex(registry, picker.browsingProvider ?? picker.candidate.providerAlias) });
      }
      return true;
    }
    if (key.name !== "return" && key.name !== "enter") return false;
    const selected = items[picker.selected];
    if (!selected) return true;
    if (picker.step === "mode") {
      void onModeSelect(picker, selected.id);
    } else if (picker.step === "provider") {
      setQualityPicker({ ...picker, step: "model", browsingProvider: selected.id, selected: 0 });
    } else {
      const providerId = picker.browsingProvider ?? picker.candidate.providerAlias;
      const candidate: QualityPickerCandidate = { providerAlias: providerId, modelId: selected.id, judgeTimeoutMs: picker.candidate.judgeTimeoutMs };
      // An explicit Change Judge selection resolves any stale/keyless retained
      // profile and re-enables direct mode actions.
      setQualityPicker({ ...picker, step: "mode", candidate, selected: modeIndexFor(picker.currentMode), requireChangeJudge: false });
      options.setStatus(`Judge candidate: ${candidate.providerAlias}/${candidate.modelId}`);
    }
    return true;
  }

  async function onModeSelect(picker: QualityPickerState, id: string): Promise<void> {
    if (id === "change-judge") {
      const registry = options.providerRegistry();
      setQualityPicker({ ...picker, step: "provider", selected: providerIndex(registry, picker.candidate.providerAlias) });
      return;
    }
    if (id === "off") {
      // Off is a mode action: it commits the current candidate (retained, active,
      // or browsed via Change Judge) as the dormant profile. It is a no-op only
      // when already off with an unchanged profile (plan selection rule 5).
      if (picker.currentMode === "off" && sameCandidate(picker.currentTuple, picker.candidate)) {
        setQualityPicker(null);
        options.setStatus("Semantic Judge is off");
        return;
      }
      await commitOff(picker.candidate);
      return;
    }
    if (id === "observe" || id === "rewrite") {
      if (picker.requireChangeJudge) {
        // A retained profile exists but cannot be enabled. Do not silently
        // substitute the active model — require an explicit Change Judge pick.
        const registry = options.providerRegistry();
        options.setStatus("retained Judge profile is unavailable; use Change Judge to pick a valid profile");
        setQualityPicker({ ...picker, step: "provider", selected: providerIndex(registry, picker.candidate.providerAlias) });
        return;
      }
    }
    if (id === "observe") {
      if (picker.currentMode === "observe" && sameCandidate(picker.currentTuple, picker.candidate)) {
        setQualityPicker(null);
        options.setStatus("Semantic Judge observe already active");
        return;
      }
      await commitObserve(picker.candidate);
      return;
    }
    if (id === "rewrite") {
      if (picker.currentMode === "rewrite" && sameCandidate(picker.currentTuple, picker.candidate)) {
        setQualityPicker(null);
        options.setStatus("Semantic Judge rewrite already active");
        return;
      }
      await stageRewrite(picker.candidate);
      return;
    }
  }

  function handleRewriteConfirmKey(key: TuiKeyEvent): boolean {
    const confirm = qualityRewriteConfirm();
    if (!confirm) return false;
    if (qualityPickerBusy()) return true; // swallow keys while a write is in flight
    if (key.name === "up" || key.name === "down" || (key.ctrl && (key.name === "p" || key.name === "n"))) {
      setQualityRewriteConfirm({ ...confirm, focused: confirm.focused === "confirm" ? "reject" : "confirm" });
      return true;
    }
    if (key.name === "escape") {
      setQualityRewriteConfirm(null);
      options.setStatus("experimental rewrite cancelled");
      return true;
    }
    if (key.name !== "return" && key.name !== "enter") return false;
    if (confirm.focused === "reject") {
      setQualityRewriteConfirm(null);
      options.setStatus("experimental rewrite cancelled");
      return true;
    }
    if (confirm.stage === 1) {
      setQualityRewriteConfirm({ ...confirm, stage: 2 });
      return true;
    }
    void commitRewrite(confirm.candidate);
    return true;
  }

  async function validateCandidate(candidate: QualityPickerCandidate): Promise<void> {
    await assertJudgeCandidateHasKey(candidate.providerAlias, candidate.modelId);
  }

  async function commitOff(candidate: QualityPickerCandidate): Promise<void> {
    setQualityPickerBusy(true);
    try {
      await writeExperimentalQualitySettings({ mode: "off", providerAlias: candidate.providerAlias, modelId: candidate.modelId, judgeTimeoutMs: candidate.judgeTimeoutMs });
      options.setStatus("experimental Semantic Judge off");
      options.setMessages((previous) => [...previous, {
        role: "system",
        content: `Experimental Semantic Judge is off. The Judge profile ${candidate.providerAlias}/${candidate.modelId} is retained for later reuse; no Judge request is made while off.`,
      }]);
      setQualityPicker(null);
    } catch (error) {
      options.reportError(error);
    } finally {
      setQualityPickerBusy(false);
    }
  }

  async function commitObserve(candidate: QualityPickerCandidate): Promise<void> {
    setQualityPickerBusy(true);
    try {
      await validateCandidate(candidate);
      await writeExperimentalQualitySettings({ mode: "observe", providerAlias: candidate.providerAlias, modelId: candidate.modelId, judgeTimeoutMs: candidate.judgeTimeoutMs });
      options.setStatus(`experimental Semantic Judge observe`);
      options.setMessages((previous) => [...previous, {
        role: "system",
        content: `Experimental Semantic Judge observe is set to ${candidate.providerAlias}/${candidate.modelId} (${candidate.judgeTimeoutMs} ms). It is not calibrated production policy.`,
      }]);
      setQualityPicker(null);
    } catch (error) {
      options.reportError(error);
    } finally {
      setQualityPickerBusy(false);
    }
  }

  async function stageRewrite(candidate: QualityPickerCandidate): Promise<void> {
    setQualityPickerBusy(true);
    try {
      await validateCandidate(candidate);
      setQualityRewriteConfirm({ stage: 1, focused: "confirm", candidate });
      options.setStatus("confirm experimental rewrite");
    } catch (error) {
      options.reportError(error);
    } finally {
      setQualityPickerBusy(false);
    }
  }

  async function commitRewrite(candidate: QualityPickerCandidate): Promise<void> {
    setQualityPickerBusy(true);
    try {
      // Revalidate immediately before the final write so registry/key drift
      // during the confirmation panel cannot enable a stale profile.
      await validateCandidate(candidate);
      await writeExperimentalQualitySettings({ mode: "rewrite", providerAlias: candidate.providerAlias, modelId: candidate.modelId, judgeTimeoutMs: candidate.judgeTimeoutMs });
      options.setStatus("experimental Semantic Judge rewrite");
      options.setMessages((previous) => [...previous, {
        role: "system",
        content: `Experimental Semantic Judge rewrite is set to ${candidate.providerAlias}/${candidate.modelId} (${candidate.judgeTimeoutMs} ms). It is not calibrated production policy.`,
      }]);
      setQualityRewriteConfirm(null);
      setQualityPicker(null);
    } catch (error) {
      options.reportError(error);
    } finally {
      setQualityPickerBusy(false);
    }
  }

  async function openQualityPicker(focusMode?: "observe" | "rewrite"): Promise<void> {
    try {
      const registry = await options.ensureProviderRegistry();
      const settings = await loadExperimentalQualitySettings();
      const resolved = resolveQualityCandidate(settings, registry, options.activeProvider(), options.activeModel());
      // A retained profile that no longer resolves or lacks its key cannot be
      // enabled silently — require Change Judge (plan rule 3).
      const retained = resolved.currentTuple;
      const requireChangeJudge = Boolean(retained)
        && (!qualityTupleResolves(retained!, registry)
          || !(await judgeCandidateHasKey(retained!.providerAlias, retained!.modelId)));
      setQualityPickerBusy(false);
      setQualityPicker({
        step: "mode",
        selected: focusMode ? modeIndexFor(focusMode) : modeIndexFor(settings.mode),
        candidate: resolved.candidate,
        currentMode: settings.mode,
        currentTuple: resolved.currentTuple,
        requireChangeJudge,
      });
      if (requireChangeJudge) {
        options.setStatus("retained Judge profile is unavailable; use Change Judge to pick a valid profile");
      }
    } catch (error) {
      options.reportError(error);
    }
  }

  /** Stage the red Rewrite confirmation from the `/quality rewrite` command. */
  async function openRewriteConfirm(candidate: QualityPickerCandidate): Promise<void> {
    setQualityRewriteConfirm({ stage: 1, focused: "confirm", candidate });
    options.setStatus("confirm experimental rewrite");
  }

  return {
    qualityPicker,
    qualityRewriteConfirm,
    qualityPickerItems,
    qualityPickerTitle,
    handleQualityPickerKey,
    handleRewriteConfirmKey,
    openQualityPicker,
    openRewriteConfirm,
  };
}

function modeIndexFor(mode: string): number {
  if (mode === "observe") return 1;
  if (mode === "rewrite") return 2;
  return 0;
}

function providerIndex(registry: ProviderRegistry | null, providerId: string): number {
  if (!registry) return 0;
  const index = registry.providers.findIndex((provider) => provider.id === providerId);
  return index >= 0 ? index : 0;
}
