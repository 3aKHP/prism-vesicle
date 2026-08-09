<!-- Generated from docs/user/en/advanced/skills.md — do not edit. -->

# Skills

A Skill is on-demand procedural context plus bundled resources in the open [Agent Skills](https://agentskills.io/specification) `SKILL.md` format. A Skill is not an Engine, Agent Profile, MCP server, or permission grant. It does not add tools, writable roots, shell authority, or provider capabilities.

## Discovery scopes and precedence

Vesicle discovers Skills from five scopes, highest to lowest precedence:

| Scope | Location | Description |
|-------|----------|-------------|
| `project` | `<project-root>/.agents/skills/<name>/` | Project convention, no separate trust gate |
| `user` | `<user-config>/skills/<name>/` | Personal authoring |
| `installed` | Skill Store snapshots | Installed via `vesicle skills install` |
| `harness` | Verified Harness `assets/skills/` | Shipped with the Harness baseline |
| `host` | Package-owned `host-assets/skills/` | First-party Skills shipped with Vesicle |

On a name collision, the higher-precedence scope wins; lower-precedence entries are reported as shadowed and never merged.

## CLI commands

```text
vesicle skills list              # List Skills from all scopes
vesicle skills inspect <name>    # Show metadata and resource inventory
vesicle skills validate <dir>    # Validate SKILL.md format
vesicle skills create <name>     # Scaffold a new Skill
vesicle skills enable <name>     # Enable
vesicle skills disable <name>    # Disable
vesicle skills install <path-or-url>
vesicle skills update <name>
vesicle skills rollback <name>
vesicle skills uninstall <name>
vesicle skills copy-template <skill> <resource-path> <dest-path>
```

## `/skill` TUI command

- `/skill` — opens a picker showing available Skills with their scope.
- `/skill <name> [task]` — activates and invokes.
- `/skill <name> --context-only` — loads context only, no provider request.

## Enable and disable

- `user` and `host` scopes share `<user-config>/skills/.disabled`.
- `project` scope uses `<project-root>/.vesicle/disabled-skills`.
- `installed` scope uses the Store index `enabled` flag.
- `harness` scope cannot be disabled.

Disabling affects newly resolved session catalogs; an already frozen catalog is unchanged.

## First-party `vesicle-docs` Skill

Every Vesicle installation ships with `vesicle-docs` (scope `host`), containing version-matched public documentation: README, user manual (Chinese/English), developer contracts, and configuration examples. It has no scripts, no process capability, and provides read-only text references through `read_skill_resource`.

When the user asks about Vesicle installation, configuration, commands, troubleshooting, or architecture, the model may automatically activate this Skill for accurate information.

## First-party `skillify` Skill

Every Vesicle installation ships with `skillify` (scope `host`). Ask Vesicle to capture, save, or turn a repeatable workflow from the current conversation into a reusable Skill, and the model activates `skillify`. It writes a draft under `tmp/skillify/<name>/` using ordinary guarded file tools, validates the complete bundle, and publishes it create-only to the project (`.agents/skills/<name>/`) or the installed Skill Store after you choose a target.

Publication is create-only: no overwrite or upgrade. The draft is always retained under `tmp/skillify/`. The published Skill is discoverable from a new session — the current session catalog does not change. Validation and publication use structured `run_skill_script` execution and do not require `shellExec` to be enabled; POSIX uses `sh`, while `.ps1` prefers PowerShell 7 (with Windows PowerShell 5.1 fallback on Windows, `pwsh` elsewhere). A missing interpreter fails clearly and retains the draft.

## First-party `novel-outline-v3` Skill

Every Vesicle installation ships with `novel-outline-v3` (scope `host`), a hierarchical novel-outline workflow (volume outline → chapter outline → scene). It teaches a text-first methodology: read all source material, maintain two living-document ledgers (character growth and world state), draft volume/chapter/scene outlines, allocate a per-chapter tension budget with closed-form checks (Σ scenes = chapter total), track foreshadow plant/resolve, write back ledgers, and mark uncertain items.

It has no scripts, no process capability, and provides read-only text references through `read_skill_resource` (outline templates, ledger formats, tension model). It complements the Harness 10.2.0 tension-budget system.

When the user asks to "outline the first three chapters", "write a volume outline", "break the outline down to scene level", "allocate tension", or "track foreshadow", the model may automatically activate this Skill.

## Stage exclusion

The Stage Engine does not resolve a Skill catalog and does not support `activate_skill`, `read_skill_resource`, or `run_skill_script`.

## Session freeze

The Skill catalog is frozen on first resolution per session. On resume, Skills are re-resolved by name and content hash; a Skill whose content changed is dropped with a diagnostic, never silently substituted.

## Capability and permissions

A Skill cannot add tools, change permission modes, widen writable roots, or override confirmation gates. Actions requested by a Skill execute with the capabilities and permission mode the user already selected.
