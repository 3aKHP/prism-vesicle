---
name: vesicle-docs
description: "Official, version-matched Prism Vesicle documentation for installation, configuration, commands, troubleshooting, workflows, permissions, Skills, Engines, and architecture. Use whenever the user asks how Vesicle works or how to use, configure, diagnose, or understand it in Chinese or English. Prefer this Skill over training knowledge for Vesicle-specific facts."
---

# Vesicle Documentation

You are answering a question about Prism Vesicle using its bundled public documentation.

## Procedure

1. Answer in the user's language unless they request another language.
2. Classify the question: installation/update, usage/workflow, commands/keys, configuration, troubleshooting, permissions/process, feature behavior, or developer/runtime architecture.
3. Read the smallest directly relevant reference. When the routing table or `references/index.md` does not settle the route, or the question is keyword-shaped (a command, flag, key, error text, or exact term), first search the mounted references with `grep_files` under `skills/vesicle-docs/` (e.g. `outputMode: "files_with_matches"`), then read the smallest hit with `read_skill_resource` (preferred, it records Skill provenance) or `read_file`, using a tight line range.
4. Route by topic:
   - Chinese user-facing questions → `docs/user/zh-CN` references.
   - English user-facing questions → `docs/user/en` references.
   - Overview or installation → `references/root-readme.md`.
   - Exact configuration shapes → `docs/examples` references.
   - Implementation/runtime contracts → `docs/dev` references.
5. Distinguish documented current behavior from suggestions. Do not invent commands, flags, file locations, defaults, configuration fields, capability support, or release status.
6. Never claim to have inspected the user's live configuration, `.env`, project state, provider availability, or runtime output unless those facts were supplied by the conversation or another authorized host surface.
7. When sources disagree, prefer the owning public authority: current source and `STATUS.md` for implemented state, owning `docs/dev` contract for runtime behavior, Simplified Chinese user pages for user-manual meaning, examples for canonical configuration shape.
8. Cite the public source path in the answer when useful. Never expose the internal absolute Skill root.
9. If the bundled docs do not answer the question, say what is missing and suggest the nearest inspect/doctor/help surface. Do not fill the gap from uncertain training memory.
10. Do not activate another Skill, execute scripts, modify configuration, or turn documentation guidance into an implied permission grant merely because this Skill is active.

## Routing table

| Topic | Reference |
|-------|-----------|
| Installation, first run, overview | `references/root-readme.md` |
| User-manual task routing | `references/user-zh-cn-readme.md` or `references/user-en-readme.md` |
| First conversation, Workspace-created source note, gates | `references/user-zh-cn-tutorials-first-conversation.md` or `references/user-en-tutorials-first-conversation.md` |
| Configuration (providers, models, env) | `references/user-zh-cn-reference-configuration.md` or `references/user-en-reference-configuration.md` |
| Commands, keyboard shortcuts | `references/user-zh-cn-reference-commands.md` or `references/user-en-reference-commands.md` |
| Terminal CLI commands | `references/user-zh-cn-reference-cli-commands.md` or `references/user-en-reference-cli-commands.md` |
| Choosing ETL, Runtime, Evaluate, Weaver, Dyad, or Stage | `references/user-zh-cn-advanced-engines.md` or `references/user-en-advanced-engines.md` |
| Web search and clipboard images | `references/user-zh-cn-tutorials-web-search-and-images.md` or `references/user-en-tutorials-web-search-and-images.md` |
| Using vesicle-docs and delegating to SubAgents | `references/user-zh-cn-tutorials-skills-and-subagents.md` or `references/user-en-tutorials-skills-and-subagents.md` |
| Resume, regenerate, candidate switching, rewind, and compaction | `references/user-zh-cn-tutorials-sessions-and-rewind.md` or `references/user-en-tutorials-sessions-and-rewind.md` |
| Skills runtime, scopes, precedence | `references/dev-skills.md` |
| Engines, Stage, profiles | `references/dev-architecture.md`, `references/dev-stage.md` |
| Tools, path guards, shell_exec | `references/dev-tools.md` |
| Session persistence and recovery contracts | `references/dev-sessions.md` |
| TUI, panels, interaction | `references/dev-tui.md` |
| Providers, protocols, adapters | `references/dev-providers.md` |
| Permissions, risk, user agency | `references/dev-user-agency-and-risk-disclosure.md` |
| Assets, Harness, V10 pack | `references/dev-assets.md` |
| Harness Pack user workflow | `references/user-zh-cn-advanced-harness-packs.md` or `references/user-en-advanced-harness-packs.md` |
| SubAgents, delegation | `references/dev-subagents.md` |
| Quality guard, validators | `references/dev-quality-guard.md` |
| Workflow, branching, PRs | `references/dev-workflow.md` |
| Style, code conventions | `references/dev-style.md` |
| Provider registry shape | `references/examples-providers-yaml.md` |
| Provider env shape | `references/examples-provider-env-example.md` |
| Windows installer | `references/user-zh-cn-start-windows-installer.md` or `references/user-en-start-windows-installer.md` |
| Shell exec usage | `references/user-zh-cn-advanced-shell-exec.md` or `references/user-en-advanced-shell-exec.md` |
| SubAgents usage | `references/user-zh-cn-advanced-subagents.md` or `references/user-en-advanced-subagents.md` |
| Quality guard usage | `references/user-zh-cn-advanced-quality-guard.md` or `references/user-en-advanced-quality-guard.md` |
| Developer doc index | `references/dev-readme.md` |
| Full index | `references/index.md` |
