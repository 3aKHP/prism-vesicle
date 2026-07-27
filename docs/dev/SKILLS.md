# Skills Runtime

A Skill is on-demand procedural context plus bundled resources in the open
[Agent Skills](https://agentskills.io/specification) `SKILL.md` format. A Skill
is **not** an Engine, Agent Profile, MCP server, permission grant, or executable
plugin. It can guide or narrow use of the current effective tool surface, but it
must never add tools, writable roots, shell authority, MCP servers, Agent scope,
permission exemptions, or provider capabilities.

This document is the authoritative runtime boundary for Skills in Vesicle. The
research basis, ecosystem comparison, and full phased delivery plan live in
`dev/docs/working/SKILLS_RUNTIME_RESEARCH_AND_FEASIBILITY.md` (an ignored local
working note; treat its archived plans as historical context).

## Phase 0 scope

Phase 0 delivers **format, inventory, and the Skill Store** only:

- strict `SKILL.md` parser and validator (`src/skills/parser.ts`);
- bounded discovery for the verified Harness and user scopes
  (`src/skills/discovery.ts`);
- collision, invalid, and unsupported-field diagnostics;
- `vesicle skills list | validate | inspect` and `vesicle doctor` integration;
- immutable versioned Skill Store, active index, and safe catalog hashing
  (`src/skills/store.ts`, `src/skills/catalog.ts`);
- **no model-visible activation.**

Phase 0 does **not** add `activate_skill` / `read_skill_resource` tools, a
`/skill` command, repository install commands (`install | update | rollback |
uninstall`), project `.agents/skills/` scope, executable script resources, or any
prompt-composition, session, compaction, or Engine-switch behavior. Those belong
to later phases and must not be implied by Phase 0 surfaces.

## What a Skill is (and is not)

| Surface | Responsibility | Loaded when | May grant capability |
|---|---|---|---|
| `VESICLE.md` | Durable user/project instructions | Prompt composition | No |
| Engine profile and prompts | Prism identity, workflow, output contract | Engine bootstrap | Declares effective host contract |
| Harness Pack | Verified Engine/Agent/prompt/validator assets | Project runtime activation | Declares verified compatibility |
| **Skill** | Optional task method, rubric, reference set, template | On demand | **No** |
| Agent Profile | Delegated worker identity and tool subset | SubAgent spawn | Within parent/Driver bounds |
| MCP | External tools and resources | Config discovery | Yes, via configured server |

A useful test: if a feature needs a new network service, tool schema, credential,
lifecycle hook, renderer, or permission, it is not "just a Skill." It belongs in
MCP, the host runtime, an Engine/Harness contract, or a future plugin system.

## Discovery scopes

Phase 0 discovers two deterministic, non-merging scopes, lowest to highest
precedence:

1. **Harness** — logical `assets/skills/<name>/SKILL.md`, resolved through the
   active verified Harness asset resolver.
2. **User** — `<user-config>/skills/<name>/SKILL.md`, direct filesystem.

The `src/skills` module takes **pre-resolved roots** and does not import the asset
resolver, providers, harness runtime, or TUI. The CLI (`src/cli/skills.ts`) owns
Harness-root resolution and passes both root lists to `discoverSkills`.

On a name collision, exactly one winner is selected by precedence (`user`
outranks `harness`); lower-precedence entries produce one `shadowed` diagnostic
each. Bodies and resources are never merged. Catalog and diagnostic shapes never
carry an absolute host path — only safe logical scope labels and skill-relative
paths.

Reserved for later phases: host-bundled Skills, project `.agents/skills/` (only
after an explicit project-trust primitive), and the installed Skill Store as a
discovery source. Project Skills must not be injected merely because a user
opened a freshly cloned directory.

## Parsing and validation

`src/skills/parser.ts` is a pure function over already-decoded text. It mirrors
the repository's pattern of a hand-written bounded YAML reader for each narrow
schema (engine profiles, Module A/B validators) so Vesicle keeps its
zero-YAML-dependency runtime. It rejects anything it cannot read unambiguously
rather than splitting frontmatter ad hoc.

Validated portable core:

- required `name`: 1–64 lowercase alphanumeric segments joined by single
  hyphens, matching the parent directory (no leading, trailing, or repeated
  hyphens);
- required nonempty `description`, maximum 1024 code points;
- optional `license`, `compatibility`, string-to-string `metadata`;
- experimental space-separated `allowed-tools` — parsed for compatibility, then
  ignored with one `allowed-tools-ignored` diagnostic;
- unknown top-level fields — preserved for inspection, flagged as
  `unsupported-field`, and ignored by runtime behavior.

Bounds (research §2): `SKILL.md` at most 64 KiB and 500 lines; at most 200
supporting resources per Skill; individual text references at most 256 KiB.

Loading (`src/skills/loader.ts`) is fail-soft per root: UTF-8 is decoded fatally,
one leading BOM is stripped, the `SKILL.md` target must be a regular file (not a
symbolic link) with a race-aware re-check, and the skill root must be a real
directory. Any I/O or parse failure is returned as an invalid result so one bad
Skill never hides its valid siblings.

## Path hardening

`src/skills/paths.ts` is the shared virtual-root guard, reused by the parser,
loader, store, and the future Phase 2 `read_skill_resource` tool. Every resource
path is skill-relative and shallow; absolute paths, `..` escapes, backslashes,
NUL, empty/dot segments, normalization ambiguity, symbolic links, devices, and
sockets are rejected.

## Skill Store

`src/skills/store.ts` keeps immutable, content-addressed snapshots:

```text
<user-config>/skill-store/
├── index.json                       active index (name → version, enabled, time)
└── <name>/
    ├── <version>/                   byte-exact standard bundle (SKILL.md + resources)
    └── <version>.provenance.json    host sidecar (source, hashes, inventory)
```

The version directory holds only the auditable standard bundle; provenance lives
in a sibling sidecar so the bundle stays byte-for-byte comparable with its
source. Snapshots are staged, re-verified by hash, and atomically renamed; an
interrupted install never leaves a live dependency on the source path or a
half-written active version. Reinstalling identical content is idempotent by
bundle hash; a differing bundle under the same version is a hard conflict.

Phase 0 ships the storage mechanism (`installSnapshot`) and the read APIs so
Phase 1 can layer repository-install commands on top without re-deriving the
immutable-snapshot contract. The store is **not yet a discovery source**.

## Catalog

`src/skills/catalog.ts` builds the bounded, frozen routing view from discovery
winners. It exposes only `name`, `description`, and a safe `scope`, capped to
~2% of the model context window when known or an 8 KiB fallback, preferring
description shortening and then omission of lowest-precedence skills. The catalog
hash is an identity fingerprint over the kept skills' `name\0scope\0contentSha256`
— description shortening does not change it, but activating, omitting, or changing
the content version of a skill does. Phase 0 builds and hashes the catalog; it is
not yet model-visible.

## CLI surface

```text
vesicle skills list
vesicle skills validate <skill-directory>
vesicle skills inspect <name>
```

`vesicle doctor` reports valid/invalid/shadowed counts over the Harness and user
scopes. None of these surfaces expose an absolute host path.

## Threat model (summary)

| Threat | Control |
|---|---|
| Malicious project `description` (pre-activation injection) | Project scope is not discovered in Phase 0; catalog renders bounded data, not instructions |
| Malicious body | Activation is a lower-authority tool result (Phase 2); explicit conflict ordering |
| Path traversal / symlink | Virtual skill root, strict relative paths, no symlinks, race-aware reads |
| `allowed-tools` abuse | Parsed but ignored; Tool Permission Runtime is authoritative |
| Script / dependency attack | No execution in Phase 0; scripts are listed but unsupported |
| Mutable remote Skill | Resolve to immutable snapshot, hash, provenance (Phase 1 install) |
| Name collision | Deterministic precedence, one winner, shadow diagnostic |
| Catalog bloat | Count/byte/context budget; identity-hash freeze |

Static scanning is useful but insufficient. Markdown can be semantically
malicious without suspicious syntax. Trust, least privilege, immutable
provenance, runtime observation, and human review remain necessary.

## Phase roadmap

- **Phase 0 — format, inventory, Skill Store** (this change).
- **Phase 1 — local and GitHub repository installation**: `install | update |
  rollback | uninstall`, staging, full-inventory validation, content hash,
  provenance, atomic activation, dirty-worktree handling.
- **Phase 2 — read-only runtime**: Engine-declared `activate_skill` and
  `read_skill_resource` tools, `/skill <name> [task]` and `--context-only`,
  `/skills` inventory, structured activation/session events, TUI rendering,
  exact resume/compact/rewind/Engine-switch semantics.
- **Phase 3 — authoring and trusted project scope**: project trust before
  `.agents/skills` disclosure, create/edit workflow, enable/disable, refresh.
- **Phase 4 — executable resources**: `run_skill_script` through bounded Process
  Runtime (separate security design first).
- **Phase 5 — registries and broader distribution**: only after the read-only
  lifecycle and supply-chain contract are correct.
