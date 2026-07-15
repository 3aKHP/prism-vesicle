import { createMemo, createSignal, type Accessor, type Setter } from "solid-js";
import type { ProviderRegistry, ProviderSelection } from "../config/providers";
import type { TuiKeyEvent } from "./decision-interaction";
import { modelOptionItems, providerOptionItems } from "./commands/options";
import type { Message, OptionItem } from "./types";
import type { ModelPickerState } from "./views/BottomSurface";

export type ModelPickerControllerOptions = {
  providerRegistry: Accessor<ProviderRegistry | null>;
  ensureProviderRegistry: () => Promise<ProviderRegistry>;
  applyProviderSelection: (selection: Partial<ProviderSelection>) => Promise<ProviderSelection>;
  persistProviderSwitch: (selection: ProviderSelection) => Promise<void>;
  setStatus: Setter<string>;
  setMessages: Setter<Message[]>;
  reportError: (error: unknown) => void;
};

export function createModelPickerController(options: ModelPickerControllerOptions) {
  const [modelPicker, setModelPicker] = createSignal<ModelPickerState | null>(null);
  const [modelPickerBusy, setModelPickerBusy] = createSignal(false);
  const modelPickerItems = createMemo<OptionItem[]>(() => {
    const picker = modelPicker();
    const registry = options.providerRegistry();
    if (!picker || !registry) return [];
    return picker.step === "provider"
      ? providerOptionItems(registry)
      : modelOptionItems(registry, picker.providerId ?? "");
  });
  const modelPickerTitle = createMemo(() => {
    const picker = modelPicker();
    return !picker || picker.step === "provider" ? "Select provider" : `Select model · ${picker.providerId}`;
  });

  function handleModelPickerKey(key: TuiKeyEvent): boolean {
    const picker = modelPicker();
    if (!picker) return false;
    if (modelPickerBusy()) return true;
    const items = modelPickerItems();
    if (items.length === 0) return false;
    if (key.name === "up" || (key.ctrl && key.name === "p")) {
      setModelPicker({ ...picker, selected: (picker.selected - 1 + items.length) % items.length });
      return true;
    }
    if (key.name === "down" || (key.ctrl && key.name === "n")) {
      setModelPicker({ ...picker, selected: (picker.selected + 1) % items.length });
      return true;
    }
    if (key.name === "return" || key.name === "enter") {
      const item = items[picker.selected];
      if (!item) return true;
      if (picker.step === "provider") setModelPicker({ step: "model", providerId: item.id, selected: 0 });
      else {
        setModelPickerBusy(true);
        options.setStatus("switching provider/model");
        void commitModelPicker(picker.providerId ?? "", item.id);
      }
      return true;
    }
    if (key.name === "escape") {
      if (picker.step === "model") setModelPicker({ step: "provider", providerId: null, selected: 0 });
      else {
        setModelPicker(null);
        options.setStatus("model switch cancelled");
      }
      return true;
    }
    return false;
  }

  async function commitModelPicker(providerId: string, modelId: string): Promise<void> {
    try {
      const selection = await options.applyProviderSelection({ provider: providerId, model: modelId });
      await options.persistProviderSwitch(selection);
      options.setMessages((previous) => [...previous, { role: "system", content: `Using ${selection.provider}/${selection.model}.` }]);
    } catch (error) {
      options.reportError(error);
    } finally {
      setModelPicker(null);
      setModelPickerBusy(false);
    }
  }

  async function openModelPicker(): Promise<void> {
    try {
      await options.ensureProviderRegistry();
      setModelPickerBusy(false);
      setModelPicker({ step: "provider", providerId: null, selected: 0 });
    } catch (error) {
      options.reportError(error);
    }
  }

  return { handleModelPickerKey, modelPicker, modelPickerItems, modelPickerTitle, openModelPicker };
}
