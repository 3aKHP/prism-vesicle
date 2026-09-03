<!-- Generated from docs/dev/SKILLS.md — do not edit. -->

# Skills Runtime

A Skill is on-demand procedural context plus bundled resources in the open [Agent Skills](https://agentskills.io/specification) `SKILL.md` format. A Skill is **not** an Engine, Agent Profile, MCP server, or permission grant. It may contain instructions, references, assets, and scripts. A Skill does not itself add tools, writable roots, shell authority, MCP servers, Agent scope, permission exemptions, or provider capabilities; actions it requests use the capabilities and permission mode the user already selected.

This document is the authoritative public runtime boundary for Skills in Vesicle. Local research and implementation plans may inform changes but are not required to understand the supported contract. Git publication operations remain governed separately by [`WORKFLOW.md`](./WORKFLOW.md).

## Phase 0 scope

Phase 0 delivers **format, inventory, and the Skill Store** only:

- strict `SKILL.md` parser and validator (`src/skills/parser.ts`);
- bounded discovery for the verified Harness and user scopes (`src/skills/discovery.ts`);
- collision, invalid, and unsupported-field diagnostics;
- `vesicle skills list | validate | inspect` and `vesicle doctor` integration;
- immutable versioned Skill Store, active index, and catalog hashing (`src/skills/store.ts`, `src/skills/catalog.ts`);
- **no model-visible activation.**

Phase 0 does **not** add `activate_skill` / `read_skill_resource` tools, a `/skill` command, repository install commands (`install | update | rollback | uninstall`), project `.agents/skills/` scope, script execution, or any prompt-composition, session, compaction, or Engine-switch behavior. Those belong to later phases and must not be implied by Phase 0 surfaces.

## Phase 1 scope

Phase 1 adds **repository installation and lifecycle** on top of the Phase 0 store, still without model-visible activation:

- local directory and local Git installation (`vesicle skills install <path>`);
- GitHub repository URL installation with ref resolution to an immutable commit (`vesicle skills install <url> [--ref <ref>] [--path <root>] [--all]`);
- repository shape detection (root, single-nested, `skills/*` collection, multi-arbitrary) with deterministic selection — it refuses to guess when multiple skills are present;
- immutable snapshot install with provenance sidecar, plus `update`, `rollback`, and `uninstall` over the active index and retained versions;
- the Skill Store as a **CLI-listable** source (`list`/`inspect` show installed skills with scope `installed`) — **not** a model-visible catalog source;
- dirty local worktree detection with explicit `--include-worktree` handling.

Phase 1 does **not** add `activate_skill` / `read_skill_resource` tools, a `/skill` command, project `.agents/skills/` scope, script execution, or any prompt-composition, session, compaction, or Engine-switch behavior. Those remain Phase 2 and must not be implied by Phase 1 surfaces.

## Phase 2 scope

Phase 2 adds **model-visible activation, resources, scripts, and the `/skill` command**:

- `activate_skill(name)` tool: host-injected for every non-Stage Engine when at least one Skill is in the session catalog. Its `name` schema is an enum of valid catalog names. The result is a tagged `skill_activation` event containing the exact body (without frontmatter), resource inventory, content hash, scope, and authority disclosure.
- `read_skill_resource(skill, path, startLine?, endLine?)` tool: reads any bundled file (references, assets, and script sources) from a previously activated Skill. Path hardening reuses `src/skills/paths.ts`. Script sources are readable without the active Engine being process-capable; only execution is gated.
- `skills/` read-only logical root: the session's activated Skills are also mounted behind the ordinary read tools (`stat_path`, `list_directory`, `grep_files`, `read_file`, `view_image`) as `skills/<name>/<skill-relative path>`. The mount lifecycle is exactly the activation registry (activating mounts; rewind or compaction loss unmounts), resolution always uses the frozen catalog winner, and `read_skill_resource` remains the provenance-faithful reader bundled Skill procedures steer to. The filesystem-side contract — hardening, caps, frozen-inventory enumeration versus live direct reads, write rejection — is owned by [`TOOLS.md`](./TOOLS.md) § Read-only `skills/` mount.
- `run_skill_script(skill, path, args[])` tool: executes a fixed, catalog-pinned script from an activated Skill through the Process Runtime as structured argv (no shell interpolation). The resource hash is rechecked immediately before execution and drift fails closed. It is available for every non-Stage session with a non-empty Skill catalog, independent of the opt-in `shell_exec` capability and `shellInterpreter`; the required interpreter is resolved from the script extension at execution time. It retains the shared environment filtering, timeout, output cap, cancellation, process-group cleanup, and host-process checkpoint taint, while its distinct `skill_exec` permission class asks in MANUAL/INERTIA and auto-allows in MOMENTUM/YOLO.
- `/skill` TUI command: bare `/skill` opens a compact picker; `/skill <name> [task]` activates and invokes; `/skill <name> --context-only` activates without a provider request; `/skill refresh` (#308) re-freezes the session catalog at the current installation content. The reserved subcommand runs immediately, reports changed/removed/added, appends nothing when nothing drifted, and shadows a Skill literally named "refresh".
- Session semantics: the catalog is frozen per session (resume re-resolves by name+hash, never silently substituting changed content). The frozen snapshot is session-level Host state projected in physical record order, so branch truncation (regenerate, rewind, candidate switching) cannot resurrect an older catalog. An activation is live only while the frozen catalog serves the same content hash it was recorded with; a confirmed Harness migration re-freezes the catalog at the current installation's content, which retires activations recorded at a stale hash until `/skill` re-activates them — the old activation record stays in history as an audit trail. `/skill refresh` (#308) is the explicit non-migration re-freeze: it appends a `skill-catalog` record under the same session-level latest-wins projection and retires stale-hash activations the same way, while resuming a drifted session whose Harness identity did not change surfaces an advisory hint pointing at the command — the resume itself never writes the catalog. The re-freeze resolves its catalog under the same config-derived context-window budget bootstrap uses, so the next bootstrap's name+hash re-resolution keeps everything the refresh froze. Activation records persist as user records with `kind: "skill-activation"`. Compaction reattaches active Skill bodies within a 16 KiB budget or reports loss. Rewind removes activation state only when the record is beyond the new head. Engine switching recomputes eligibility and prunes the activation registry.
- Authority ordering: Vesicle host enforcement > Engine/Harness contract > user request and persistent instructions > activated Skill procedure > Skill references. A Skill cannot add tools, change permissions, widen writable roots, or override gates.

Phase 2 does **not** add project `.agents/skills/` scope, Skill authoring workflows, registries, or broader distribution.

## Phase 3 scope

Phase 3 adds **project scope, authoring, enable/disable, and template copy**:

- Project `.agents/skills/` discovery: Skills under `<project-root>/.agents/skills/<name>/SKILL.md` enter the catalog with visible `project` scope attribution. No separate project-trust gate; installation into the project directory is the authorization. Precedence: `project` > `user` > `installed` > `harness`.
- `vesicle skills create <name> [--scope user|project] [--force]`: scaffolds a standard Agent Skills directory (`SKILL.md` + `scripts/` + `references/` + `assets/`) with a valid template. Refuses to overwrite without `--force`; with `--force`, backs up the existing directory first.
- `vesicle skills enable <name>` / `disable <name>`: toggles availability. Installed Skills use the store active-index `enabled` flag; user and project filesystem Skills use line-delimited disabled-names files (`<user-config>/skills/.disabled` and `<project-root>/.vesicle/disabled-skills`). Disabled Skills are excluded at catalog resolution; the frozen-per-session contract is unchanged.
- `vesicle skills copy-template <skill> <resource-path> <dest-path>`: copies a Skill resource into an approved durable content root. Path hardening applies to the source; the destination must be under `source_materials/`, `workspace/`, `novels/`, `reports/`, or `test_runs/`. The scratch root `tmp/` is not an approved destination.

Phase 3 does **not** add registries, broader distribution, or SubAgent Skill inheritance.

## What a Skill is (and is not)

| Surface | Responsibility | Loaded when | May grant capability |
|---|---|---|---|
| `VESICLE.md` | Durable user/project instructions | Prompt composition | No |
| Engine profile and prompts | Prism identity, workflow, output contract | Engine bootstrap | Declares effective host contract |
| Harness Pack | Verified Engine/Agent/prompt/validator assets | Project runtime activation | Declares verified compatibility |
| **Skill** | Optional task method, rubric, reference set, template | On demand | **No** |
| Agent Profile | Delegated worker identity and tool subset | SubAgent spawn | Within parent/Driver bounds |
| MCP | External tools and resources | Config discovery | Yes, via configured server |

A useful test: if a feature needs a new network service, tool schema, credential, lifecycle hook, renderer, or permission, it is not "just a Skill." It belongs in MCP, the host runtime, an Engine/Harness contract, or a future plugin system.

## Discovery scopes

Discovery resolves four deterministic, non-merging filesystem scopes plus the installed Skill Store, from lowest to highest precedence:

1. **Host** — package-owned first-party Skills under `host-assets/skills/<name>/SKILL.md`, resolved from the bundled package layout beside the module root or executable. Host Skills are Vesicle extensions independent of the active Harness; a managed Harness selection cannot replace, relocate, or suppress them except through ordinary same-name precedence.
2. **Harness** — logical `assets/skills/<name>/SKILL.md`, resolved through the active verified Harness asset resolver.
3. **Installed** — enabled Skill Store snapshots (`<user-config>/skill-store/<name>/<version>/`), resolved from the active index.
4. **User** — `<user-config>/skills/<name>/SKILL.md`, direct filesystem.
5. **Project** — `<project-root>/.agents/skills/<name>/SKILL.md`, direct filesystem with visible project provenance. No separate trust gate.

The `src/skills` module takes **pre-resolved roots** and does not import the asset resolver, providers, harness runtime, or TUI. A shared filesystem-source resolver (`src/core/skills/catalog-sources.ts`) resolves all four filesystem scopes and is used by both the CLI inventory owner (`src/cli/commands/skills/inventory.ts`) and the session catalog (`src/core/skills/catalog.ts`).

On a name collision, exactly one winner is selected by precedence (`project` > `user` > `installed` > `harness` > `host`); lower-precedence entries produce one `shadowed` diagnostic each. Bodies and resources are never merged. Catalog and diagnostic shapes never carry an absolute host path — only logical source scopes and skill-relative paths.

Filesystem-scope Skills (user, project, host) support disable state via line-delimited names files. User and Host scopes share `<user-config>/skills/.disabled`; project uses `<project-root>/.vesicle/disabled-skills`. Installed Skills use the active-index `enabled` flag. Harness remains non-disableable. Disabled Skills are excluded from the session catalog at resolution time; the catalog remains frozen per session.

## Parsing and validation

`src/skills/parser.ts` is a pure function over already-decoded text. It mirrors the repository's pattern of a hand-written bounded YAML reader for each narrow schema (engine profiles, Module A/B validators) so Vesicle keeps its zero-YAML-dependency runtime. It rejects anything it cannot read unambiguously rather than splitting frontmatter ad hoc.

Validated portable core:

- required `name`: 1–64 lowercase alphanumeric segments joined by single hyphens, matching the parent directory (no leading, trailing, or repeated hyphens);
- required nonempty `description`, maximum 1024 code points;
- optional `license`, `compatibility`, string-to-string `metadata`;
- experimental space-separated `allowed-tools` — parsed for compatibility, then ignored with one `allowed-tools-ignored` diagnostic;
- unknown top-level fields — preserved for inspection, flagged as `unsupported-field`, and ignored by runtime behavior.

Bounds (research §2): `SKILL.md` at most 64 KiB and 500 lines; at most 200 supporting resources per Skill; individual text references at most 256 KiB.

Loading (`src/skills/loader.ts`) is fail-soft per root: UTF-8 is decoded fatally, one leading BOM is stripped, the `SKILL.md` target must be a regular file (not a symbolic link) with a race-aware re-check, and the skill root must be a real directory. Any I/O or parse failure is returned as an invalid result so one bad Skill never hides its valid siblings.

## Path hardening

`src/skills/paths.ts` is the shared virtual-root guard, reused by the parser, loader, store, and the `read_skill_resource` tool. Every resource path is skill-relative and shallow; absolute paths, `..` escapes, backslashes, NUL, empty/dot segments, normalization ambiguity, symbolic links, devices, and sockets are rejected.

## Skill Store

`src/skills/store.ts` keeps immutable, content-addressed snapshots:

```text
<user-config>/skill-store/
├── index.json                       active index (name → version, enabled, time)
├── index-lock.sqlite                cross-process index coordination
└── <name>/
    ├── <version>/                   byte-exact standard bundle (SKILL.md + resources)
    └── <version>.provenance.json    host sidecar (source, hashes, inventory)
```

The version directory holds only the auditable standard bundle; provenance lives in a sibling sidecar so the bundle stays byte-for-byte comparable with its source. Snapshots are staged, re-verified by hash, and atomically renamed; an interrupted install never leaves a live dependency on the source path or a half-written active version. Reinstalling identical content is idempotent by bundle hash; a differing bundle under the same version is a hard conflict.

Phase 0 shipped the storage mechanism (`installSnapshot`) and read APIs; Phase 1 layers repository-install commands and lifecycle (`update`, `rollback`, `uninstall`) on top without re-deriving the immutable-snapshot contract. The active-index read-modify-write is serialized in process and across processes by a SQLite `BEGIN IMMEDIATE` transaction; process exit releases the lock without stale-owner guessing. The store is both a CLI-listable source (`list`/`inspect`) and a model-visible catalog source (scope `installed`, since Phase 2).

## Catalog

`src/skills/catalog.ts` builds the bounded, frozen routing view from discovery winners. It exposes only `name`, `description`, and a logical source `scope`, capped to ~2% of the model context window when known or an 8 KiB fallback, preferring description shortening and then omission of lowest-precedence skills. The catalog hash is an identity fingerprint over the kept skills' `name\0scope\0contentSha256` — description shortening does not change it, but activating, omitting, or changing the content version of a skill does. The catalog is model-visible: it injects into the system prompt when at least one Skill is eligible.

## CLI surface

```text
vesicle skills list
vesicle skills validate <skill-directory>
vesicle skills validate <skill-directory> --draft --json [--quiet-success]
vesicle skills publish-draft <draft-directory> --target project|installed --json
vesicle skills inspect <name>
vesicle skills create <name> [--scope user|project] [--force]
vesicle skills enable <name>
vesicle skills disable <name>
vesicle skills copy-template <skill-name> <resource-path> <dest-path>
vesicle skills install <path-or-url> [--ref <ref>] [--path <root>] [--all] [--include-worktree]
vesicle skills update <name>
vesicle skills rollback <name>
vesicle skills uninstall <name>
```

`vesicle skills list` and `inspect` show Skills from all scopes (host, harness, user, project, installed) with their scope label and a `(disabled)` flag when toggled off. `vesicle doctor` reports valid/invalid/shadowed counts plus the installed count. `create` scaffolds a standard Agent Skills directory with a valid `SKILL.md` template; `--force` backs up and replaces an existing Skill. `enable`/`disable` toggle availability across all scopes (installed uses the store index; user, project, and host use line-delimited disabled-names files). `copy-template` copies a Skill resource into an approved durable content root (`source_materials/`, `workspace/`, `novels/`, `reports/`, `test_runs/`); the scratch root `tmp/` is not an approved destination. `inspect` of an installed Skill shows its provenance (source kind and identity, requested ref, resolved commit, dirty-source marker, bundle hash); for local sources the source identity is the local path, shown only in this user-facing CLI output and never in model-facing catalog or diagnostic shapes.

## Risk disclosure and runtime boundaries

Apply the cross-cutting policy in [`USER_AGENCY_AND_RISK_DISCLOSURE.md`](./USER_AGENCY_AND_RISK_DISCLOSURE.md). Explicit installation is the user's decision to make a Skill available. Vesicle must show its source, resolved version, bundled scripts, declared requirements, and material warnings, but it must not add a second trust ceremony or block a valid Skill based on a host judgment about its intent.

| Risk or condition | Product response |
|---|---|
| Project or remote instructions influence model behavior | Show source scope and version; keep activation observable; do not require a separate trust gate |
| Skill conflicts with Engine/Harness or requests unavailable capability | Apply normal instruction precedence and report the conflict or unavailable capability |
| Path traversal, escaping symlink, socket, or device | Reject because it cannot be represented inside a stable portable Skill root |
| `allowed-tools` declares capabilities | Display it as compatibility metadata; effective tools and the user's Permission Runtime mode remain authoritative |
| Bundled script or dependency can execute code, access the network, or modify files | Show script inventory and requirements; execute the fixed Skill resource through Process Runtime under `skill_exec`, without enabling or accepting a free-form shell command |
| Remote ref can change | Resolve the installed version to a commit and content hash; show update diffs and retain rollback |
| Name collision | Select deterministically and show winning and shadowed scopes |
| Catalog bloat affects context and cache behavior | Apply count/context budgets and report omitted entries |

Static scanning may produce useful warnings, but it cannot certify Markdown or code as benign. Findings are disclosures, not a content-approval gate or an implied safety certification when no warning is emitted. Format validation, portable path rules, immutable provenance, and runtime observation protect correctness and auditability without replacing the user's judgment.

## Scratch-first draft publication (`skillify`)

The bundled `skillify` Skill turns a proven workflow from the current conversation into a reusable portable Skill. It is a first-party Host Skill activated through the ordinary catalog; it adds no new model-visible tools, permission grants, or capability surfaces.

The flow is scratch-first and create-only:

1. The model writes a draft bundle under `tmp/skillify/<name>/` using ordinary guarded file tools. No other draft root is accepted.
2. The model validates the draft through one of two thin wrapper scripts (`scripts/publish_skill.sh` on POSIX, `scripts/publish_skill.ps1` on Windows), which relay a versioned JSON contract from the non-model-visible CLI.
3. After an explicit publication target decision, the model publishes create-only to `project` (`.agents/skills/<name>/`) or `installed` (the Skill Store).

`vesicle skills validate <dir> --draft --json` accepts only the exact `tmp/skillify/<name>` project-relative path and returns one `vesicle.skill-draft/v1` JSON envelope with the bundle hash, content-addressed version, and file count. `--quiet-success` emits no stdout on success so the publish wrapper can validate before publication without producing two success objects. `vesicle skills publish-draft <dir> --target project|installed --json` revalidates and re-hashes inside the publication transaction and returns the logical destination, hash, and version.

Publication is create-only: no overwrite, merge, upgrade, backup-and-replace, or partial update. Project publication uses sibling staging and atomic rename; installed publication uses a name-level create-only Store API under the existing cross-process lock. If a first installed publication crashes after its exact content-addressed version reaches the Store, a retry may finish only the missing provenance/index commit after verifying the version bytes and any existing provenance inventory; conflicting or additional retained state remains a collision. The draft is always retained. The current session catalog is never mutated — the published Skill is discoverable only from a new session.

First-party wrappers re-invoke the exact Vesicle runtime through Host-owned `VESICLE_SELF_EXECUTABLE` and `VESICLE_SELF_ENTRYPOINT` values injected into the filtered `run_skill_script` child environment. `VESICLE_HOST_CONFIG_DIR` (the resolved user-level configuration directory) is injected alongside them so bundled scripts can locate config files without re-deriving platform paths or environment overrides. The wrappers never guess `vesicle` from `PATH`, never expose the absolute executable path in their output, and contain no path, hash, copy, staging, or cleanup logic — all safety lives in the CLI and the portable bundle seam. Any process-authorized Skill script can observe and deliberately print its own child environment; persisted events omit these paths unless script output itself contains them.

## Current boundary

The shipped runtime covers format, inventory, the Skill Store, repository installation with lifecycle, model-visible activation with resources, scripts, and the `/skill` TUI command, project `.agents/skills/` discovery with visible provenance, Skill authoring (`create`), enable/disable across all scopes, text template copy into approved durable content roots, Host-bundled first-party Skill discovery from `host-assets/skills/`, and the scratch-first `skillify` workflow with create-only draft publication. The first-party `vesicle-docs` Skill ships version-matched public documentation as bundled references readable through `read_skill_resource` — and searchable through the ordinary `grep_files` tool via the activated-`skills/` read-only mount — without process capability. The bundled `novel-outline-v3` Skill ships a hierarchical novel-outline workflow (volume → chapter → scene, per-chapter tension-budget allocation with closed-form checks, foreshadow tracking, and two living-document ledgers for character growth and world state) as readable references without scripts or process capability. The bundled `update-config` Skill guides configuration changes through validated `vesicle config` CLI operations via two thin `.sh`/`.ps1` wrappers; `.env` reads are whitelist-sanitized and no operation accepts a secret value as an argument. The `skillify` Skill ships with two thin publish wrappers (`.sh` and `.ps1`) that relay the non-model-visible JSON CLI contract. The Skill Store is both CLI-listable and a model-visible catalog source (scope `installed`). The following are **not** part of the current contract and must not be implied by any current surface:

- registries or broader distribution; and
- SubAgent Skill inheritance (children do not receive parent Skills).

Current capability state and known limits belong in [`STATUS.md`](../../STATUS.md). Later delivery phases are internal planning; they do not change this boundary until their runtime contract lands and is documented here.
