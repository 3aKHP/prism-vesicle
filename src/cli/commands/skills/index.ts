// skills CLI dispatch — routes the first subcommand to its domain module.
// Each domain (inventory/draft/lifecycle/authoring) owns its own parse, render,
// and error envelope; this module only selects which handler to invoke.

export { inspectSkills } from "./inventory";
export type { SkillsInspection } from "./inventory";

import { runList, runInspect } from "./inventory";
import { runValidate, runPublishDraft } from "./draft";
import { runInstall, runUpdate, runRollback, runUninstall } from "./lifecycle";
import { runCreate, runEnableDisable, runCopyTemplate } from "./authoring";

export async function runSkillsCommand(args: string[]): Promise<void> {
  const command = args[0];
  if (command === "list" && args.length === 1) {
    await runList();
    return;
  }
  if (command === "validate") {
    await runValidate(args.slice(1));
    return;
  }
  if (command === "publish-draft") {
    await runPublishDraft(args.slice(1));
    return;
  }
  if (command === "inspect" && args.length === 2) {
    await runInspect(args[1]!);
    return;
  }
  if (command === "install" && args.length >= 2) {
    await runInstall(args.slice(1));
    return;
  }
  if (command === "update" && args.length === 2) {
    await runUpdate(args[1]!);
    return;
  }
  if (command === "rollback" && args.length === 2) {
    await runRollback(args[1]!);
    return;
  }
  if (command === "uninstall" && args.length === 2) {
    await runUninstall(args[1]!);
    return;
  }
  if (command === "create" && args.length >= 2) {
    await runCreate(args.slice(1));
    return;
  }
  if (command === "enable" && args.length === 2) {
    await runEnableDisable(args[1]!, true);
    return;
  }
  if (command === "disable" && args.length === 2) {
    await runEnableDisable(args[1]!, false);
    return;
  }
  if (command === "copy-template" && args.length >= 3) {
    await runCopyTemplate(args.slice(1));
    return;
  }
  printUsage();
  process.exitCode = 1;
}

function printUsage(): void {
  console.error("Usage:");
  console.error("  vesicle skills list");
  console.error("  vesicle skills validate <skill-directory> [--draft --json [--quiet-success]]");
  console.error("  vesicle skills publish-draft <draft-directory> --target project|installed --json");
  console.error("  vesicle skills inspect <name>");
  console.error("  vesicle skills create <name> [--scope user|project] [--force]");
  console.error("  vesicle skills enable <name>");
  console.error("  vesicle skills disable <name>");
  console.error("  vesicle skills copy-template <skill-name> <resource-path> <dest-path>");
  console.error("  vesicle skills install <path-or-url> [--ref <ref>] [--path <root>] [--all] [--include-worktree]");
  console.error("  vesicle skills update <name>");
  console.error("  vesicle skills rollback <name>");
  console.error("  vesicle skills uninstall <name>");
}
