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

Phase 0 discovers two deterministic, non-merging scopes, lowest to highest precedence:

1. **Harness** — logical `assets/skills/<name>/SKILL.md`, resolved through the active verified Harness asset resolver.
2. **User** — `<user-config>/skills/<name>/SKILL.md`, direct filesystem.

The `src/skills` module takes **pre-resolved roots** and does not import the asset resolver, providers, harness runtime, or TUI. The CLI (`src/cli/skills.ts`) owns Harness-root resolution and passes both root lists to `discoverSkills`.

On a name collision, exactly one winner is selected by precedence (`user` outranks `harness`); lower-precedence entries produce one `shadowed` diagnostic each. Bodies and resources are never merged. Catalog and diagnostic shapes never carry an absolute host path — only logical source scopes and skill-relative paths.

Reserved for later phases: host-bundled Skills, project `.agents/skills/`, and the installed Skill Store as a discovery source. Project Skills may enter the catalog when their project is opened; their source scope must remain visible, without a separate project-trust state.

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

`src/skills/paths.ts` is the shared virtual-root guard, reused by the parser, loader, store, and the future Phase 2 `read_skill_resource` tool. Every resource path is skill-relative and shallow; absolute paths, `..` escapes, backslashes, NUL, empty/dot segments, normalization ambiguity, symbolic links, devices, and sockets are rejected.

## Skill Store

`src/skills/store.ts` keeps immutable, content-addressed snapshots:

```text
<user-config>/skill-store/
├── index.json                       active index (name → version, enabled, time)
└── <name>/
    ├── <version>/                   byte-exact standard bundle (SKILL.md + resources)
    └── <version>.provenance.json    host sidecar (source, hashes, inventory)
```

The version directory holds only the auditable standard bundle; provenance lives in a sibling sidecar so the bundle stays byte-for-byte comparable with its source. Snapshots are staged, re-verified by hash, and atomically renamed; an interrupted install never leaves a live dependency on the source path or a half-written active version. Reinstalling identical content is idempotent by bundle hash; a differing bundle under the same version is a hard conflict.

Phase 0 ships the storage mechanism (`installSnapshot`) and the read APIs so Phase 1 can layer repository-install commands on top without re-deriving the immutable-snapshot contract. The store is **not yet a discovery source**.

## Catalog

`src/skills/catalog.ts` builds the bounded, frozen routing view from discovery winners. It exposes only `name`, `description`, and a logical source `scope`, capped to ~2% of the model context window when known or an 8 KiB fallback, preferring description shortening and then omission of lowest-precedence skills. The catalog hash is an identity fingerprint over the kept skills' `name\0scope\0contentSha256` — description shortening does not change it, but activating, omitting, or changing the content version of a skill does. Phase 0 builds and hashes the catalog; it is not yet model-visible.

## CLI surface

```text
vesicle skills list
vesicle skills validate <skill-directory>
vesicle skills inspect <name>
```

`vesicle doctor` reports valid/invalid/shadowed counts over the Harness and user scopes. None of these surfaces expose an absolute host path.

## Risk disclosure and runtime boundaries

Apply the cross-cutting policy in [`USER_AGENCY_AND_RISK_DISCLOSURE.md`](./USER_AGENCY_AND_RISK_DISCLOSURE.md). Explicit installation is the user's decision to make a Skill available. Vesicle must show its source, resolved version, bundled scripts, declared requirements, and material warnings, but it must not add a second trust ceremony or block a valid Skill based on a host judgment about its intent.

| Risk or condition | Product response |
|---|---|
| Project or remote instructions influence model behavior | Show source scope and version; keep activation observable; do not require a separate trust gate |
| Skill conflicts with Engine/Harness or requests unavailable capability | Apply normal instruction precedence and report the conflict or unavailable capability |
| Path traversal, escaping symlink, socket, or device | Reject because it cannot be represented inside a stable portable Skill root |
| `allowed-tools` declares capabilities | Display it as compatibility metadata; effective tools and the user's Permission Runtime mode remain authoritative |
| Bundled script or dependency can execute code, access the network, or modify files | Show script inventory and requirements; execute through Process Runtime with the same permissions as an equivalent process action |
| Remote ref can change | Resolve the installed version to a commit and content hash; show update diffs and retain rollback |
| Name collision | Select deterministically and show winning and shadowed scopes |
| Catalog bloat affects context and cache behavior | Apply count/context budgets and report omitted entries |

Static scanning may produce useful warnings, but it cannot certify Markdown or code as benign. Findings are disclosures, not a content-approval gate or an implied safety certification when no warning is emitted. Format validation, portable path rules, immutable provenance, and runtime observation protect correctness and auditability without replacing the user's judgment.

## Phase roadmap

- **Phase 0 — format, inventory, Skill Store** (this change).
- **Phase 1 — local and GitHub repository installation**: `install | update | rollback | uninstall`, staging, full-inventory validation, content hash, provenance, atomic activation, dirty-worktree handling.
- **Phase 2 — activation, resources, and scripts**: Engine-declared `activate_skill` / `read_skill_resource`, bare `/skill` inventory and picker, `/skill <name> [task]`, `--context-only`, and `run_skill_script` for process-capable Engines through existing Process/Permission Runtime behavior; structured activation/session events, TUI rendering, and exact resume/compact/rewind/Engine-switch semantics.
- **Phase 3 — authoring and project scope**: `.agents/skills` discovery with visible project provenance and no separate trust state, create/edit workflow, enable/disable, and refresh.
- **Phase 4 — registries and broader distribution**: optional distribution work after direct local/GitHub repository installation is established.
