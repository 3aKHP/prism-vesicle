<!-- Generated from docs/user/en/tutorials/skills-and-subagents.md — do not edit. -->

# Use Skills for guidance and SubAgents for delegation

English | [简体中文](../../zh-CN/tutorials/skills-and-subagents.md)

A Skill gives the model on-demand instructions and resources. A SubAgent starts a child runtime with its own context and tool scope. Use the former to “learn how to do this” and the latter to “hand off one bounded piece of work.” Neither expands permissions.

## Let the model consult Vesicle's own manual

Every installation includes the read-only `vesicle-docs` Skill, matched to that Vesicle version. Confirm it exists:

```bash
vesicle skills inspect vesicle-docs
```

Success shows the `host` scope, description, and resource inventory. In the TUI, ask an executable question:

> Use vesicle-docs to tell me how to resume an old session. Read the relevant user-manual resource first, then give steps I can follow now, the success feedback, and what to do if it fails.

The model should activate the Skill, read at least one resource, and then answer. You can also invoke it explicitly:

```text
/skill vesicle-docs How do I resume an old session and switch candidate branches?
```

To load documentation context without immediately starting a provider request:

```text
/skill vesicle-docs --context-only
```

After activation, the transcript reports the activated Skill and resources read. Skill resources are reference material. If the manual conflicts with the real command, retain the exact discrepancy and report it through [Troubleshooting](../reference/troubleshooting.md).

### If the Skill is missing or ineffective

- First run `vesicle skills list` and `vesicle skills inspect vesicle-docs` to identify the effective scope and whether the problem is disabled, invalid, or shadowed. `vesicle doctor` also summarizes valid / invalid / shadowed counts.
- If `list` has no `vesicle-docs` entry and `inspect` reports `No skill named`, reinstall the same current Vesicle version; this host Skill is part of the package.
- If it is `(disabled)`, run `vesicle skills enable vesicle-docs`.
- If it is `invalid`, follow the `inspect` diagnostic to repair the corresponding project/user `SKILL.md`, then run `vesicle skills validate <that-skill-directory>`. If the packaged host `vesicle-docs` is invalid, reinstall the same Vesicle version.
- If a project/user custom Skill with the same name shadows the built-in host `vesicle-docs`, back up that custom directory, then move it out of `.agents/skills/vesicle-docs/` or the user-config `skills/vesicle-docs/`, or give it a different valid name. `enable` cannot remove a shadow.
- Start a **new session** after the repair. The Skill catalog freezes when first resolved and is not hot-replaced in the current session.
- Stage loads no Skills. Use `/new` to return to ETL or another ordinary Engine first.

## Delegate one task to a SubAgent

A good task has explicit input, output, and prohibitions. For example:

> Ask an explore SubAgent to read-only inspect the character material under source_materials/. Return a file list, a one-sentence summary of each item, and missing information. Do not modify files. Run it in the background while we continue discussing the character goal.

The parent model calls `spawn_agent`; a successful background start returns a short handle such as `explore-1`. Continue the main conversation immediately. Completion is delivered automatically when the parent session is idle, so polling is usually unnecessary.

Manage it in the TUI:

```text
/agents
/agents explore-1
/agents stop explore-1
```

- `/agents` lists installed Agent Profiles and this session's task states.
- `/agents <handle>` inspects one task.
- `/agents stop <handle>` interrupts a running or queued task.
- If provider failure prevents result delivery, fix the connection and run `/agents retry` to retry **delivery**; it is not an unconditional full-task rerun.

A foreground SubAgent holds the current model turn until its result arrives, while the TUI remains responsive. A background SubAgent returns its handle immediately. Up to four top-level children run concurrently by default; children cannot spawn grandchildren.

### Restarts and file conflicts

When Vesicle restarts, active SubAgents are marked failed and a terminal result is delivered to the parent. Their provider requests are not silently replayed. Inspect `/agents <handle>` before deciding whether to delegate the work again.

If parallel tasks may write files, assign non-overlapping target paths in each prompt. Vesicle rejects detected overlapping write ownership, but clear division also avoids contradictory content. Candidate switching and regeneration wait until active SubAgents finish or are interrupted.

## When not to use a SubAgent

- Looking up one command: let the current model read `vesicle-docs` instead.
- A task needs frequent questions for you: keep it in the main conversation.
- You only need fixed recurring rules: use [Persistent Instructions](./persistent-instructions.md).
- You need an external database or service: use [MCP](../advanced/mcp.md), not a SubAgent.

## Checklist

- [ ] `vesicle skills inspect vesicle-docs` showed version-bundled documentation resources.
- [ ] The model read a `vesicle-docs` resource before answering one concrete question.
- [ ] You can write a SubAgent task with input, output, and prohibitions.
- [ ] You know background results auto-deliver, restarts do not replay, and `/agents stop <handle>` interrupts work.

See [Skills](../advanced/skills.md) for the full lifecycle and [SubAgents](../advanced/subagents.md) for Agent Profile and Driver-contract details.
