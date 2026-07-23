# Set up Persistent Instructions for a project

English | [简体中文](../../zh-CN/tutorials/persistent-instructions.md)

If every new session starts with the same naming rules, writing constraints, or project workflow, put them in Persistent Instructions. Vesicle automatically loads these Markdown files into sessions, but they can only guide the existing workflow; they cannot add tools, permissions, or filesystem authority.

## Generate the first project instructions

Open Vesicle in a project that already contains some source material or artifacts, then enter:

```text
/init Focus on character and scenario-card naming rules, plus setting details this project must not reveal too early
```

`/init` scans the Vesicle project roots and asks the current provider to draft `VESICLE.md` at the project root. Open the file when generation finishes, remove incorrect inference or rules that are too broad, and only then continue. This is editable project configuration, not a model-output artifact.

If the project already has `VESICLE.md`, ordinary `/init` refuses before calling the provider. Only when you intend to replace it should you run:

```text
/init --force Keep the existing naming rules and add the latest scenario-card constraints
```

Forced generation first preserves the old file at `.vesicle/init-backups/VESICLE.md.previous`. Do not use `--force` as a substitute for reviewing the draft.

## Confirm what is active

Enter this in Vesicle:

```text
/instructions
```

The result lists the user- and project-scope files selected for the current engine, their byte sizes, the combined budget, and any warnings. Send one ordinary turn asking the model to summarize the project constraints it must follow, then compare the answer with `VESICLE.md`.

A project-root `VESICLE.md` applies to every engine. To replace it only for Runtime, create `VESICLE.runtime.md`; within one scope, an engine-specific file **replaces** the general file rather than merging with it. User-scope files live in the same config directory as `providers.yaml` and apply across projects. Project instructions follow user instructions, and project content wins a direct conflict.

## Ask the model to help edit

On a non-Stage engine, ask the model to read before it changes anything:

> Read the current project-general Persistent Instructions. Preserve the existing rules, add “character-card filenames use lowercase kebab-case,” and identify the target you are about to modify.

The model uses `read_instructions` and `update_instructions`. A mutation follows the current permission mode; when approval is required, inspect the target scope and new content first. After a successful write, the new instructions take effect from the next provider request in the same turn. Stage has no model-visible tools, so it cannot use this path.

## Understand the recovery boundary

Persistent Instructions are host configuration, not rewind-managed artifacts. `/rewind` or double Esc can rewind conversation and guarded files, but they **do not** restore an instruction file changed by `update_instructions`. The disk change may remain even after the tool call disappears from the visible conversation.

After every successful mutation, the tool result identifies one previous-state backup:

- If the target existed, copy the reported `.previous` file back over the target.
- On first creation, the matching `.previous.json` only records that the target was absent; recover by deleting the new target.

The next mutation replaces this single backup. Check its path and content before recovery; it is not a version history.

## Checklist

- [ ] You generated and manually reviewed a project `VESICLE.md` with `/init`.
- [ ] You used `/instructions` to confirm the files selected for the active engine.
- [ ] You know that an engine-specific file replaces the general file in the same scope.
- [ ] You know that `/rewind` does not restore Persistent Instructions and can find the manual recovery hint.

For complete scope, budget, and file-location details, see [Configuration files](../reference/configuration.md). Next, learn [Permissions and the host shell](./permissions-and-shell.md).
