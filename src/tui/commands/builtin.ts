// Built-in slash command registry. The command BODIES live in per-domain
// modules (provider, engine, session, quality, skills, workspace, theme,
// agents, permissions, help); each domain factory closes over its own narrow
// context so adding a field for one family never touches the others. This
// module is the composition root: it calls every factory and concatenates the
// results into the single Command[] the App registers with the dispatcher and
// the completion controller.

import type { BuiltinCommandContexts, Command } from "./types";
import { createProviderCommands } from "./provider";
import { createEngineCommands } from "./engine";
import { createSessionCommands } from "./session";
import { createQualityCommands } from "./quality";
import { createSkillCommands } from "./skills";
import { createWorkspaceCommands } from "./workspace";
import { createThemeCommands } from "./theme";
import { createAgentsCommands } from "./agents";
import { createPermissionsCommands } from "./permissions";
import { createHelpCommands } from "./help";

export function createBuiltinCommands(contexts: BuiltinCommandContexts): Command[] {
  return [
    ...createProviderCommands(contexts.provider),
    ...createEngineCommands(contexts.engine),
    ...createSessionCommands(contexts.session),
    ...createQualityCommands(contexts.quality),
    ...createSkillCommands(contexts.skills),
    ...createWorkspaceCommands(contexts.workspace),
    ...createThemeCommands(contexts.theme),
    ...createAgentsCommands(contexts.agents),
    ...createPermissionsCommands(contexts.permissions),
    ...createHelpCommands(contexts.help),
  ];
}
