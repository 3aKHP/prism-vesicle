---
name: skillify
description: "Turn a proven workflow from the current conversation into a reusable portable Prism Vesicle Skill. Use when the user asks to capture, extract, preserve, package, or 沉淀 a repeatable process as SKILL.md with optional scripts, references, or assets, then validate and publish it to the current project or the installed Skill Store."
---

# skillify

Capture a genuinely reusable process from this conversation into a portable Skill, validate it, and publish it create-only to the project (`.agents/skills/`) or the installed Skill Store. The draft always lives under `tmp/skillify/<name>/`; nothing is published until the user decides.

## When to activate

Activate when the user asks to save, capture, package, turn into, or 沉淀 a repeatable workflow, procedure, or rubric as a Skill. Do not activate for one-off results, generic advice, or when the user only wants a written summary outside the Skill format.

## Procedure

1. **Confirm reusability.** The conversation must contain a genuinely repeatable process — not a single ad-hoc answer. If the work is one-off, say so and stop.

2. **Extract the process** from what is visible in this conversation or explicitly supplied files. Capture:
   - the recurring goal and trigger conditions;
   - the successful ordered procedure;
   - failed approaches only when their correction is reusable;
   - required tools, files, services, environment, or platform assumptions;
   - observable verification and completion criteria;
   - known boundaries, non-goals, and escalation points;
   - reusable references, templates, or scripts when they materially help.

3. **Propose identity.** Suggest a lowercase-hyphenated `name` and a trigger-rich `description`. Ask the user only if a material choice is genuinely ambiguous; do not force a fixed number of interview rounds.

4. **Create the draft under `tmp/skillify/<name>/` only.** Write `SKILL.md` first, then create only the supporting directories (`scripts/`, `references/`, `assets/`) that the Skill actually needs. Do not use `vesicle skills create` — it scaffolds directly into durable locations and bypasses the scratch-first flow.

5. **Keep SKILL.md procedural.** Put the working procedure in the body and progressively disclose detail into `references/`, `scripts/`, or `assets/` rather than pasting the raw transcript.

6. **Strip non-portable content.** Remove secrets, user-specific absolute paths, session ids, provider keys, private URLs, and transient output. Keep only what another project would need.

7. **Read the draft back.** Verify every referenced resource file exists and the `name` in the frontmatter matches the directory name.

8. **Select the platform wrapper.** Use `scripts/publish_skill.sh` on POSIX systems and `scripts/publish_skill.ps1` on Windows.

9. **Validate.** Run the wrapper `validate` operation on the draft. Repair all blocking diagnostics in the draft, then validate again until it passes.

10. **Summarize before publishing.** State the draft name, triggers, resources, dependencies, and the validation hash so the user can confirm.

11. **Confirm the publication target.** An explicit request such as "publish this to the project" is already the decision — do not ask again. Otherwise ask `project` versus `installed` once.

12. **Publish.** Run the wrapper `publish` operation only after the target decision.

13. **Report the result.** State the destination, bundle hash/version, that the draft was retained, and that the user should start a new session to discover the published Skill.

14. **Never** delete the draft automatically, and **never** claim the current session catalog changed — publication is visible only from a new session.

## Wrapper usage

Both wrappers accept exactly:

```
validate <tmp/skillify/<name>>
publish  <tmp/skillify/<name>> <project|installed>
```

The draft directory is always project-relative, starting with `tmp/skillify/`. The wrappers revalidate before publishing; a prior `validate` result is never trusted for changed bytes.

## Failure handling

- **Process unavailable:** If `run_skill_script` is not available in this session, retain the draft and explain that validation and publication require Process Runtime with a resolved shell profile. Do not claim success or write to `.agents/skills/` directly.
- **Invalid bundle:** Edit only the draft under `tmp/skillify/`, then retry validation. Never attempt to fix the bundle by copying files into the destination.
- **Target exists:** Stop, retain the draft, and explain that first-version `skillify` does not overwrite or upgrade an existing Skill. The user should choose a new name.
- **Publication failure:** Report the structured error code from the wrapper output, retain the draft, and do not attempt manual copying.
- **User wants modifications after a failure:** Continue editing the draft in `tmp/skillify/` and revalidate.
- **User wants to modify an already published Skill:** Explain that first-version `skillify` requires a new name or a separately authorized future upgrade workflow.

## Boundaries

This Skill does not read hidden memory, session JSONL, or provider credentials. It works only from what is visible in the current conversation or explicitly supplied files. It does not add tools, widen permissions, or bypass the Tool Permission Runtime. Publication is create-only: no overwrite, merge, upgrade, backup-and-replace, or automatic draft deletion.
