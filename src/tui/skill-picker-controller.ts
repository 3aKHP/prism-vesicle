import { createMemo, createSignal, type Accessor, type Setter } from "solid-js";
import type { EngineId } from "../core/engine/profile";
import type { TuiKeyEvent } from "./decision-interaction";
import { resolveSkillCatalog, resolveEngineEligibleCatalog } from "../core/skills";
import type { ResolvedSkillCatalog } from "../core/skills";
import type { Message, OptionItem } from "./types";

export type SkillPickerState = {
  selected: number;
};

export type SkillPickerControllerOptions = {
  rootDir: string;
  env: NodeJS.ProcessEnv;
  activeEngineProfile: Accessor<{ id: EngineId; defaultTools?: readonly string[] }>;
  contextWindow: Accessor<number | undefined>;
  setStatus: Setter<string>;
  setMessages: Setter<Message[]>;
  reportError: (error: unknown) => void;
  onActivate: (name: string) => Promise<void>;
};

export function createSkillPickerController(options: SkillPickerControllerOptions) {
  const [skillPicker, setSkillPicker] = createSignal<SkillPickerState | null>(null);
  const [skillPickerBusy, setSkillPickerBusy] = createSignal(false);
  const [resolvedCatalog, setResolvedCatalog] = createSignal<ResolvedSkillCatalog | null>(null);

  const skillPickerItems = createMemo<OptionItem[]>(() => {
    const catalog = resolvedCatalog();
    if (!catalog) return [];
    return catalog.catalog.entries.map((entry) => {
      const skill = catalog.byName.get(entry.name);
      const scriptCount = skill?.parsed.ok
        ? skill.parsed.resources.filter((r) => r.kind === "script").length
        : 0;
      const scriptTag = scriptCount > 0 ? ` · ${scriptCount} script${scriptCount > 1 ? "s" : ""}` : "";
      return {
        id: entry.name,
        label: entry.name,
        detail: `[${entry.scope}]${scriptTag} ${entry.description}`,
      };
    });
  });

  const skillPickerTitle = createMemo(() => {
    const catalog = resolvedCatalog();
    const count = catalog?.catalog.entries.length ?? 0;
    return count === 0 ? "No skills available" : `Skills (${count})`;
  });

  function handleSkillPickerKey(key: TuiKeyEvent): boolean {
    const picker = skillPicker();
    if (!picker) return false;
    if (skillPickerBusy()) return true;
    const items = skillPickerItems();
    if (items.length === 0) {
      if (key.name === "escape") {
        setSkillPicker(null);
        return true;
      }
      return false;
    }
    if (key.name === "up" || (key.ctrl && key.name === "p")) {
      setSkillPicker({ selected: (picker.selected - 1 + items.length) % items.length });
      return true;
    }
    if (key.name === "down" || (key.ctrl && key.name === "n")) {
      setSkillPicker({ selected: (picker.selected + 1) % items.length });
      return true;
    }
    if (key.name === "return" || key.name === "enter") {
      const item = items[picker.selected];
      if (!item) return true;
      setSkillPickerBusy(true);
      options.setStatus(`activating ${item.id}`);
      void commitSkillPicker(item.id);
      return true;
    }
    if (key.name === "escape") {
      setSkillPicker(null);
      options.setStatus("skill picker closed");
      return true;
    }
    return false;
  }

  async function commitSkillPicker(name: string): Promise<void> {
    try {
      await options.onActivate(name);
    } catch (error) {
      options.reportError(error);
    } finally {
      setSkillPicker(null);
      setSkillPickerBusy(false);
    }
  }

  async function openSkillPicker(): Promise<void> {
    try {
      setSkillPickerBusy(true);
      const profile = options.activeEngineProfile();
      const catalog = await resolveSkillCatalog(
        options.rootDir,
        options.env,
        profile,
        options.contextWindow(),
      );
      const eligible = resolveEngineEligibleCatalog(catalog, profile);
      setResolvedCatalog(eligible);
      setSkillPickerBusy(false);
      setSkillPicker({ selected: 0 });
    } catch (error) {
      setSkillPickerBusy(false);
      options.reportError(error);
    }
  }

  return {
    handleSkillPickerKey,
    skillPicker,
    skillPickerItems,
    skillPickerTitle,
    openSkillPicker,
  };
}
