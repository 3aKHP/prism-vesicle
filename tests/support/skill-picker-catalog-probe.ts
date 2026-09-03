/**
 * Reactive probe for the `/skill` picker controller (#309). Must run under
 * `bun --preload @3akhp/opentui-solid/preload`: in-process unit tests load
 * solid's server build, where memos never re-evaluate after a signal write,
 * so memo-driven picker state (items, title, selection) needs the preload's
 * reactive build — the same constraint and pattern as
 * `tests/support/markdown-theme-probe.tsx`.
 */
import { createRoot, createSignal } from "solid-js";
import { createSkillPickerController } from "../../src/tui/skill-picker-controller";
import type { ResolvedSkillCatalog } from "../../src/core/skills";
import type { LoadedSkill } from "../../src/skills/types";

function stubLoadedSkill(name: string): LoadedSkill {
  return {
    name,
    scope: "user",
    rootDirectory: `/stub/${name}`,
    parsed: {
      ok: true,
      metadata: { name, description: `${name} description`, unknownFields: [] },
      body: `# ${name}`,
      bodySha256: "0".repeat(64),
      bytes: 42,
      lines: 2,
      resources: [],
      diagnostics: [],
    },
  };
}

function stubCatalog(names: string[]): ResolvedSkillCatalog {
  const skills = names.map(stubLoadedSkill);
  return {
    catalog: {
      entries: skills.map((skill) => ({
        name: skill.name,
        scope: skill.scope,
        description: skill.parsed.ok ? skill.parsed.metadata.description : "",
      })),
      hash: `hash-${names.join("+")}`,
      omitted: [],
      diagnostics: [],
    },
    byName: new Map(skills.map((skill) => [skill.name, skill])),
  };
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`skill picker catalog probe: ${message}`);
}

const [, setStatus] = createSignal("");

// The picker lists exactly the injected session-aware resolver's catalog —
// never a fresh disk scan (#309).
{
  const controller = createRoot(() => createSkillPickerController({
    resolveCatalog: async () => stubCatalog(["alpha", "beta"]),
    setStatus,
    reportError: (error) => {
      throw error;
    },
    onActivate: async () => {},
  }));
  await controller.openSkillPicker();
  const ids = controller.skillPickerItems().map((item) => item.id);
  assert(JSON.stringify(ids) === JSON.stringify(["alpha", "beta"]), `items come from the resolver: ${JSON.stringify(ids)}`);
  assert(controller.skillPickerTitle() === "Skills (2)", "the title reflects the resolver's count");
  assert(controller.skillPicker()?.selected === 0, "the picker opens at the first item");
}

// Enter activates the selected item through the host activation port.
{
  const activated: string[] = [];
  const controller = createRoot(() => createSkillPickerController({
    resolveCatalog: async () => stubCatalog(["alpha", "beta"]),
    setStatus,
    reportError: () => {},
    onActivate: async (name) => {
      activated.push(name);
    },
  }));
  await controller.openSkillPicker();
  controller.handleSkillPickerKey({ name: "down" });
  controller.handleSkillPickerKey({ name: "return" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert(JSON.stringify(activated) === JSON.stringify(["beta"]), `Enter activates the selected item: ${JSON.stringify(activated)}`);
  assert(controller.skillPicker() === null, "the picker closes after activation");
}

// A resolver failure is reported and keeps the picker closed.
{
  const errors: unknown[] = [];
  const controller = createRoot(() => createSkillPickerController({
    resolveCatalog: async () => {
      throw new Error("catalog resolution failed");
    },
    setStatus,
    reportError: (error) => {
      errors.push(error);
    },
    onActivate: async () => {},
  }));
  await controller.openSkillPicker();
  assert(errors.length === 1, `the failure is reported exactly once: ${errors.length}`);
  assert(controller.skillPicker() === null, "the picker stays closed on failure");
}

console.log("skill picker catalog probe passed");
