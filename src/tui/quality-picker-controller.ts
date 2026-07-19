import { createMemo, createSignal, type Accessor, type Setter } from "solid-js";
import { loadConfigForSelection } from "../config/providers";
import { writeExperimentalQualitySettings } from "../config/quality";
import type { TuiKeyEvent } from "./decision-interaction";
import { modelOptionItems, providerOptionItems } from "./commands/options";
import type { Message, OptionItem } from "./types";
import type { ProviderRegistry } from "../config/providers";
import type { QualityPickerState } from "./views/BottomSurface";

export function createQualityPickerController(options: {
  providerRegistry: Accessor<ProviderRegistry | null>;
  ensureProviderRegistry: () => Promise<ProviderRegistry>;
  setStatus: Setter<string>;
  setMessages: Setter<Message[]>;
  reportError: (error: unknown) => void;
}) {
  const [qualityPicker, setQualityPicker] = createSignal<QualityPickerState | null>(null);
  const [qualityPickerBusy, setQualityPickerBusy] = createSignal(false);
  const qualityPickerItems = createMemo<OptionItem[]>(() => {
    const picker = qualityPicker();
    const registry = options.providerRegistry();
    if (!picker) return [];
    if (picker.step === "mode") return [
      { id: "off", label: "Off", detail: "No Judge requests" },
      { id: "observe", label: "Observe", detail: "Record experimental findings" },
      { id: "rewrite", label: "Rewrite", detail: "Requires confirmation" },
    ];
    if (picker.step === "provider") return registry ? providerOptionItems(registry) : [];
    if (picker.step === "model") return registry ? modelOptionItems(registry, picker.providerId) : [];
    return [
      { id: "enable", label: "Enable rewrite", detail: "Use the existing two-attempt Runtime lifecycle" },
      { id: "cancel", label: "Cancel", detail: "Keep the current setting" },
    ];
  });
  const qualityPickerTitle = createMemo(() => {
    const picker = qualityPicker();
    if (!picker || picker.step === "mode") return "Experimental Semantic Judge";
    if (picker.step === "provider") return `Judge provider · ${picker.mode}`;
    if (picker.step === "model") return `Judge model · ${picker.providerId}`;
    return `Confirm experimental rewrite · ${picker.providerId}/${picker.modelId}`;
  });

  function handleQualityPickerKey(key: TuiKeyEvent): boolean {
    const picker = qualityPicker();
    if (!picker) return false;
    if (qualityPickerBusy()) return true;
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
      } else if (picker.step === "provider") setQualityPicker({ step: "mode", selected: 0 });
      else if (picker.step === "model") setQualityPicker({ step: "provider", mode: picker.mode, selected: 0 });
      else setQualityPicker({ step: "model", mode: "rewrite", providerId: picker.providerId, selected: 0 });
      return true;
    }
    if (key.name !== "return" && key.name !== "enter") return false;
    const selected = items[picker.selected];
    if (!selected) return true;
    if (picker.step === "mode") {
      if (selected.id === "off") void commit("off");
      else setQualityPicker({ step: "provider", mode: selected.id as "observe" | "rewrite", selected: 0 });
    } else if (picker.step === "provider") {
      setQualityPicker({ step: "model", mode: picker.mode, providerId: selected.id, selected: 0 });
    } else if (picker.step === "model") {
      if (picker.mode === "observe") void commit("observe", picker.providerId, selected.id);
      else setQualityPicker({ step: "confirm", providerId: picker.providerId, modelId: selected.id, selected: 0 });
    } else if (selected.id === "enable") {
      void commit("rewrite", picker.providerId, picker.modelId);
    } else {
      setQualityPicker(null);
      options.setStatus("experimental rewrite cancelled");
    }
    return true;
  }

  async function commit(mode: "off" | "observe" | "rewrite", providerAlias?: string, modelId?: string): Promise<void> {
    setQualityPickerBusy(true);
    try {
      if (mode !== "off") {
        const config = await loadConfigForSelection({ provider: providerAlias, model: modelId });
        if (!config.apiKey) throw new Error(`Provider ${providerAlias} is missing ${config.apiKeyLabel ?? "its API key"}.`);
      }
      await writeExperimentalQualitySettings(mode === "off"
        ? { mode }
        : { mode, providerAlias: providerAlias!, modelId: modelId!, judgeTimeoutMs: 15_000 });
      options.setStatus(`experimental Semantic Judge ${mode}`);
      options.setMessages((previous) => [...previous, {
        role: "system",
        content: mode === "off"
          ? "Experimental Semantic Judge is off. Future turns make no Judge request."
          : `Experimental Semantic Judge ${mode} is set to ${providerAlias}/${modelId} (15000 ms). It is not calibrated production policy.`,
      }]);
      setQualityPicker(null);
    } catch (error) {
      options.reportError(error);
    } finally {
      setQualityPickerBusy(false);
    }
  }

  async function openQualityPicker(): Promise<void> {
    try {
      await options.ensureProviderRegistry();
      setQualityPickerBusy(false);
      setQualityPicker({ step: "mode", selected: 0 });
    } catch (error) {
      options.reportError(error);
    }
  }

  return { qualityPicker, qualityPickerItems, qualityPickerTitle, handleQualityPickerKey, openQualityPicker };
}
