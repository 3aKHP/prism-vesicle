# Skills Runtime

Skills are on-demand procedural context plus bundled resources in the open
Agent Skills `SKILL.md` format. A Skill is never an Engine, Agent Profile, MCP
server, or permission grant. It may contain instructions, references, assets,
and scripts, but cannot itself widen the current effective tool surface.

Phase 0 (format, inventory, and Skill Store) is implemented here:

- `parser.ts` — strict `SKILL.md` frontmatter and body validator.
- `paths.ts` — skill-relative path hardening and bounded resource enumeration.
- `loader.ts` — reads one skill root (fatal UTF-8, BOM, symlink rejection).
- `discovery.ts` — Harness and user scope scanning with collision resolution.
- `catalog.ts` — effective catalog builder with a byte budget and identity hash.
- `store.ts` — immutable, content-addressed Skill Store with an active index.
- `types.ts` / `index.ts` — shared types and the public surface.

There is no model-visible activation in this phase. See
`docs/dev/SKILLS.md` for the runtime boundary and
`dev/docs/working/SKILLS_RUNTIME_RESEARCH_AND_FEASIBILITY.md` for the approved
implementation plan, research basis, and Phase 1-4 delivery contract.
