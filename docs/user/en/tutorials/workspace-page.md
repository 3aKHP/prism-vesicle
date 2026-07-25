# View and edit artifacts in the Workspace page

English | [简体中文](../../zh-CN/tutorials/workspace-page.md)

The Workspace page is Vesicle's built-in project-file workbench. Use it to inspect, validate, and make small edits after a conversation without opening VS Code for every title or field change.

## Open an artifact

From the Chat page, enter:

```text
/artifact
```

Vesicle switches to the Workspace page and opens the latest artifact. You can also use `/workspace workspace/character-card.md` to locate any project file, or press `Ctrl+O` to move between Chat and Workspace.

With the file tree focused:

- use `↑` / `↓` to select and `→` / `Enter` to expand a directory or open a file;
- press `Ctrl+P` to quick-open by filename;
- press `.` to show or hide dotfiles and noisy directories;
- use `F6` / `Shift+F6` to cycle through the tree, viewer/editor, and input box.

## Edit and validate

Text files enter the editor directly. Markdown opens in preview; press `m` for the editable source.

1. Edit the file; use `Ctrl+Z` / `Ctrl+Y` to undo or redo.
2. Press `Ctrl+F` to find text or `Ctrl+G` to go to a line.
3. Press `Ctrl+S` for an atomic save. Character and scenario cards automatically run their matching validators.
4. When the status line reports findings, press `v` in the tree or read-only viewer. Select a finding and press `Enter` to jump to its location.

If another program changed the file on disk, saving asks you to overwrite, save as, or cancel; it never silently overwrites the external edit. Pressing `Esc` with unsaved content likewise asks whether to save, discard, or cancel.

## Manage files

The focused file tree provides:

- `a` to create a file and `A` to create a directory;
- `m` or `F2` to move or rename;
- `c` to copy;
- `d` to delete.

Every path must stay inside the current project root. Delete moves the target to `.vesicle/trash/` instead of permanently removing it, and directories can be deleted only when empty. Overwrites and deletions always ask for confirmation.

## Hand off to an external editor

With a file open, press `Ctrl+X`. Vesicle suspends its interface, starts your external editor, then resumes, reloads, and validates the file when the editor exits. It resolves the editor in this order:

```text
VESICLE_EDITOR → editor in settings.yaml → VISUAL → EDITOR → platform default
```

If the active buffer has unsaved changes, Vesicle refuses the handoff and asks you to press `Ctrl+S` first so the two editors cannot overwrite each other.

## Switch themes

Use `/theme dark`, `/theme light`, or `/theme auto` to switch temporarily. `auto` follows the terminal's light/dark mode; the choice lasts for the current session only.

## Checklist

- [ ] You opened a file with `/artifact` or `/workspace <path>`.
- [ ] You edited a text file and saved it with `Ctrl+S`.
- [ ] You saw validator results or an explicit `no validator matched`.
- [ ] You know `Ctrl+O` returns to Chat and deleted files can be recovered from `.vesicle/trash/`.

See the [command cheatsheet](../reference/commands.md) for every key. Next, learn how to [keep working during a turn](./work-while-running.md).
