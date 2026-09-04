# Command cheatsheet

English | [简体中文](../../zh-CN/reference/commands.md)

Type a command starting with `/` in the input box; typing `/` opens a candidate menu (↑↓ to choose, Tab/Enter to complete, Esc to cancel). Commands with finite or guarded runtime arguments also open the same menu after a space; free-text arguments remain ordinary text. Each command owns its argument grammar.

## Session and context

| Command | Purpose |
|---|---|
| `/help` | List all commands |
| `/new` | Start a fresh session |
| `/resume` | List this project's sessions to resume; `/resume <n\|id>` resumes directly |
| `/rewind` (alias `/checkpoint`) | Rewind to a step in this session, optionally restoring guarded artifact files; Persistent Instruction configuration is not restored |
| `/branch` | Open the candidate-tree panel to browse and switch candidate branches at any depth (shortcut Ctrl+B) |
| `/compact [instructions]` | Compact the current session into a summary and continue, saving context |
| `/init [--force] [notes]` | Scan the project and draft a project-scope `VESICLE.md`; refuses an existing target unless `--force` backs it up and replaces it |
| `/context` | Show current context usage and window occupancy |
| `/instructions` | Show the Persistent Instructions active for the current engine (files, byte sizes, budget, and warnings) |
| `/btw <question>` | Ask a temporary side question about the current conversation without interrupting the turn; no args reopens the latest answer |
| `/title` | Show the durable session title and source |
| `/title rename <text>` | Set a permanent user-authored session title |
| `/title regenerate` | Reset automatic title-generation attempts |

## Model and engine

| Command | Purpose |
|---|---|
| `/model [provider] [model]` | Switch provider/model; no args opens a picker |
| `/engine [id] [--summary [instructions]]` | Show or switch the Prism engine; `--summary` compacts before switching |
| `/stage <character-card-path> <scenario-card-path>` | Start a Stage narrative session from two cards |
| `/effort off\|low\|medium\|high\|xhigh\|max\|auto` | Control the model's thinking effort; `auto` restores the provider default |
| `/reasoning hidden\|collapsed\|expanded` | Control reasoning display (aliases off/preview/on) |
| `/theme [dark\|light\|default\|auto] [--persist] [--unset-project]` | Switch the interface theme; `default` follows the terminal's own mode, `auto` follows the clock; `--persist` writes `.vesicle/preferences.yaml`, `--unset-project` removes the project preference; with no argument it reports preference/source/resolved mode |
| `/websearch [on\|off]` | Show or toggle the model's built-in web search; it is available only when the protocol/profile, model capability, and current Engine tool surface all admit it, otherwise the command explains the rejection; the default comes from the model entry's `webSearchDefault` in providers.yaml, and `/new` or resuming a session reverts to it; while enabled, searches run on the provider side, queries leave with the request, and no per-call approval applies — see the Built-in Web Search section of the privacy policy |
| `/workspace [path]` | Switch to the Workspace page (project-file workbench); with a path, locates that file or directory in the tree; `Ctrl+O` toggles between the two pages (available while a bottom-surface prompt panel or picker is open; the startup splash and the `/btw` overlay still own the keyboard) |

## Artifacts

| Command | Purpose |
|---|---|
| `/artifact [n\|path]` | Open an artifact in the Workspace page viewer; no args opens the latest one |
| `/validate <n\|path>` | Validate an artifact by number or path |

The Host sidebar lists artifacts in a narrow column. Press `Alt+A` to focus that list (only when the sidebar is visible and at least one artifact exists): `↑`/`↓` move the focus, `Enter` opens the existing `/artifact` preview, and `Esc` or `Alt+A` returns to the input box. The focused file's full relative path shows in an untruncated strip while focus is active; the sidebar rows themselves stay one line.

## Permissions and quality

| Command | Purpose |
|---|---|
| `/permissions [MANUAL\|INERTIA\|MOMENTUM\|YOLO]` | Show or set the tool approval mode |
| `/quality [off\|observe [provider model [timeout-ms]]\|rewrite [provider model [timeout-ms]]]` | Show or configure the experimental Semantic Judge; no arguments open guided settings. `off` disables the Judge and retains the profile; `observe`/`rewrite` without a profile use the retained or active provider/model. Selecting Review and revise (or `/quality rewrite`) opens one red confirmation panel — there is no `/quality confirm` second command |
| `/agents [handle\|stop <handle>\|retry]` | List, inspect, interrupt, or retry SubAgent delivery |
| `/skill [refresh \| name [task]]` | Activate a Skill; no args opens a picker, `<name> [task]` activates and invokes, `<name> --context-only` loads without invoking, `refresh` re-freezes the session catalog at the current installation content, reporting Skills that changed (re-activate with `/skill <name>`), were removed, or were newly added; it changes nothing when the catalog already matches |

## Input-box keys

| Key | Purpose |
|---|---|
| Enter | Send while idle; queue ordinary messages and deferred commands while the Agent Loop is running |
| Ctrl+Enter | Newline |
| Up (running turn, empty box) | Retrieve the latest queued input for editing |
| Esc | Interrupt the current provider or tool operation; after rebuilding the interrupted session, submit the captured FIFO head once — only if it is still the queue head — or just interrupt when the queue is empty |
| Double Esc (empty box, within 800ms) | Open the rewind picker |
| Double Esc (box has text) | Save the draft and clear it, without sending |
| Ctrl+V / Alt/Option+V | Paste a clipboard image (only vision-capable models receive it; terminal text paste still inserts text normally) |
| `Ctrl+R` (Chat page) | Re-run the last turn as a new candidate (the old one is kept); in Workspace, `Ctrl+R` keeps its file-reload meaning |
| `Option+←/→` | Switch between the current turn's candidates |
| `Ctrl+B` | Open the candidate-tree panel to browse and switch candidate branches at any depth (both pages) |
| `Alt/Option+↑/↓` | Move the turn-focus cursor across the whole transcript (wraps); the focused turn's prompt and final reply are highlighted |
| Ctrl+Q | Exit Vesicle |

After a complete tool round, queued messages are added to the active conversation before its next provider request. If the loop completes without another tool boundary, the next queued input is processed immediately. Slash commands declare their own busy-turn behavior: `/help`, `/context`, `/reasoning`, `/theme`, `/workspace`, read-only settings forms, and `/agents` inspection or stop run immediately; `/artifact` and `/validate` wait for the current tool round; configuration changes, pickers, session commands, `/compact`, `/init`, and `/agents retry` wait for the Agent Loop. A picker pauses the remaining queue, and switching or resetting the session clears it.

## Interactive prompt keys

When permission approvals, stop gates, questions, and quality decisions arrive as bottom panels, each panel has two key sets and `Tab` toggles between them:

| Key (options zone) | Action |
|---|---|
| ↑ / ↓ / Ctrl+P / Ctrl+N | Move focus between the options |
| Type / paste directly | Expands the focused confirm option's note input on stop-gate and engine-switch prompts; permission prompts carry notes only on Reject (always-on input). Esc clears the note and returns to the options |
| Enter | Submit the focused option; a typed note is submitted with the decision (permission Allow takes no note) |
| Tab / Shift+Tab | Switch to the body zone to read the folded summary / command detail |
| Esc | Clear the note and move focus to Reject |

| Key (body zone) | Action |
|---|---|
| ↑ / ↓ | Scroll the folded body line by line; a bright position row (e.g. `▾ lines 5-8 of 30`) marks the window |
| Home / End | Jump to the top / bottom |
| Tab / Enter / Esc | Return to the options zone (Enter in the body zone **never** submits) |

Question prompts wrap their question text with the same budget and scrolling; the quality-decision panel is a fixed option list with no body zone. While the body is folded the panel shows an accent-colored `▸ N lines folded · Tab to read` affordance row, and the rail column beside the body lights up in the brand color when the body zone holds the keyboard and stays dim while the options do — the focused zone is visible at a glance. The panel hint line shows the keys available in the current zone.

## Workspace page keys

The Workspace page has three focus regions: the file tree, the viewer / editor, and the input box. `F6` / `Shift+F6` cycle between them (the viewer is skipped when no file is open), and `Esc` steps focus back (editor → tree → input box; Markdown source has one extra level: source → preview → tree). Printable shortcuts only act in their focused region and never collide with the input box.

Interactive decision prompts that arrive mid-turn (permission approval, stop gates, questions, quality decisions) do not take over this page's bottom: they collapse to a one-line pending strip above the input box (e.g. `◆ Permission pending · Ctrl+O to answer`), the keyboard stays with the three focus regions, and the workbench is never occluded. Press `Ctrl+O` to see the full prompt on the Chat page and answer it there; until it is answered, Enter in the input box neither sends nor queues — the draft is kept as-is. Pickers and confirms you open yourself (YOLO confirm, migration review, …) still show their full panels at the bottom.

### File tree and read-only viewer

| Key | Purpose |
|---|---|
| Ctrl+P or / (tree focus) | Quick open: subsequence fuzzy match across project files; Enter opens, Esc closes |
| ↑ / ↓ (tree) | Move the selection |
| → / Enter (tree) | Expand a directory, or open a file and hand focus to the viewer/editor |
| ← (tree) | Collapse a directory or move to the parent |
| a (tree) | Create a file (path input bar; `a/b/c.md` works, parents are created; an existing target is refused, not overwritten) |
| A (tree, Shift+a) | Create a directory |
| m / F2 (tree) | Move / rename (input bar prefills the directory prefix; type the new name; an existing target opens an overwrite confirm) |
| c (tree) | Copy (same rules as `m`) |
| d (tree) | Delete: `y` deletes (moves to the `.vesicle/trash/` recycle bin); any other key cancels; directories only when empty; unsaved edits are noted in the confirm |
| v (tree) | Validate the **selection**: a selected file validates and opens findings; a directory or empty selection shows `select a file to validate`; a file with unsaved edits shows `save <path> before validating` |
| v (read-only viewer) | Validate the open file and open findings (labelled `v findings` when a current result exists) |
| h / j / k / l (tree/read-only viewer) | Alias for the arrow keys (inert while a text input is active) |
| q (tree/read-only viewer) | Alias for Esc — step focus back one level |
| r (tree) | Refresh the directory; (read-only viewer) re-read the file |
| . (tree) | Show/hide dotfiles and noisy directories (`.git`, `node_modules`, `dist`, …) |
| ↑ / ↓ / PgUp / PgDn / Home / End (read-only viewer) | Scroll |
| m (Markdown preview / read-only source) | Toggle preview and source: an editable Markdown shows `m edit`; a read-only/oversized/truncated Markdown shows `m source` (read-only source) or `m preview`; a metadata-only symlink offers no toggle |

Every file-management op stays inside the project root (rejects `..` and absolute paths). Delete is a **recycle bin** (move to `.vesicle/trash/<timestamp>-<name>`), never a permanent removal; the status line shows where it went, and recovery is a manual move back. Renaming or moving a file you are editing rekeys the buffer to the new path (the dirty flag and content survive; the undo stack resets — save first if undo matters). Move or copy onto an existing target opens an "overwrite / cancel" confirm.

### Editor (editable source focus)

Text and Markdown files under 512 KB / 2000 lines, writable, and not symlinks are editable in source mode; Markdown defaults to preview and `m` enters the source. Each file gets its own editing buffer (up to 8, LRU-evicted, dirty buffers protected), each with its own undo history.

| Key | Purpose |
|---|---|
| Ctrl+S | Save (atomic write, project-root-bounded, rejects `..` and absolute paths); re-runs validation on save |
| Ctrl+Shift+S | Save as (type a new path) |
| Ctrl+Z / Ctrl+Y | Undo / redo |
| Ctrl+F | Find: locate as you type, Enter next, Shift+Enter previous, Esc close |
| Ctrl+G | Go to line (type a line number) |
| Ctrl+R | Reload the on-disk version (confirms if there are local edits or the disk changed) |
| Tab | Insert two spaces of indentation |
| Esc | With unsaved edits: "save / discard / cancel"; otherwise step back one level |

If the file changed on disk since you opened it (by mtime), saving opens an "overwrite / save as / cancel" confirm — it never silently overwrites. Switching back to the Workspace page stats every open buffer; changed ones are marked `†disk` in the title and can be reloaded with Ctrl+R. Image, binary, symlink, oversized, and read-only files stay in the read-only viewer.

### Validation (findings panel)

Opening a file, saving, or pressing `v` in the tree or read-only viewer runs the **character-card / scenario-card** validators (the same list `/validate` and the turn-finalizer auto-check use). Each result is owned by the file it describes: the status line shows a summary only for the current focus target (tree = the selection, viewer/editor = the open file), so moving the tree selection never misattributes another file's verdict. The summary is pure state — `✓ validators passed` / `✗ N · ⚠ M` / `validation stale` / `no validator matched` (stated explicitly when nothing applies); each focus region adds its own single action hint, and an action never appears twice.

Entering the editable source does not re-run validation on every keystroke; the prior verdict is projected as a neutral `validation stale` (no old green/red/amber colour or counts). Undoing back to the saved content restores it as current; saving or reloading installs a fresh current verdict. In editable source `v` is an ordinary letter (it goes to the editor), so to validate manually, save first (Ctrl+S auto-validates).

Tree-focus `v` targets the **selection**: a selected regular file validates it and opens the findings panel (consuming an already-current snapshot rather than re-running); a directory or empty selection stays closed with `select a file to validate`; a file with unsaved edits shows `save <path> before validating` instead of passing off the older disk content as current. Viewer-focus `v` targets the open file and is labelled `v findings` when a current result exists.

The findings panel owns the keyboard: its header reads `findings: <path> — <summary>` to identify the target (pure state, no action hint); each row is `✗/⚠ + finding text` (unanchored ones marked `(no anchor)`), `↑↓` selects, and `Enter` jumps to the finding's line (located by pulling a `## …` section header or frontmatter key out of the message and `indexOf`-ing it; missing-field findings fall back to the frontmatter close) — but `Enter jump` is shown and executed only for a genuinely editable target (read-only, oversized, truncated, or non-admitted files do not jump), and `Esc` closes.

### External editor handoff

**Ctrl+X** (any Workspace focus region — tree / viewer / editor / composer when a file is open) suspends the Vesicle UI, hands the file you are viewing or editing to your real editor, and resumes when it exits, refreshing from the result.

- **Editor resolution** (git's order, specific to general): `$VESICLE_EDITOR` → the `editor:` field of the user-level `settings.yaml` → `$VISUAL` → `$EDITOR` → platform fallback (`vi` on POSIX, `notepad` on Windows). Command lines are split with quote awareness (`code --wait`, paths with spaces all work) and the file path is passed as a separate argv element — never through a shell.
- **`settings.yaml`** is a new user-level config file (beside `providers.yaml`, same `key: value` line format, `version: 1`). Only `editor` is read for now; the rest is reserved for future settings (e.g. theme persistence).
- **An unsaved buffer is refused** with a pointer to `Ctrl+S`, so the external editor's write cannot silently clobber your local edits.
- **On return**: an open editable buffer is compared by mtime — changed → reloaded (`replaceText`, undo preserved) and revalidated as if saved; unchanged → `no changes`; deleted or replaced with a symlink → closed; a file that was only selected in the tree just refreshes the directory cache and index. Read-only / image / binary files may be handed off too (whether the editor can write them is its concern).
- A missing editor command (ENOENT) → status-line error naming the resolved command; a non-zero exit → warn, then refresh anyway.

## `/btw` side questions

`/btw` asks a one-shot, tool-free question about the current conversation without interrupting the active turn. It copies the frozen context boundary published before each main provider request, so it never observes a half-written tool round; but the parent Engine prompt, conversation, and tool results are placed inside one user message as **reference material**, with the dedicated side prompt as the only system instruction — parent workflow intent, tool protocol, and reasoning state never become active side instructions. The answer comes from an independent side request to the active session's provider/model (declaring no tools) and streams into a temporary overlay while the main turn keeps running underneath.

| Key | Purpose |
|---|---|
| Esc / Space / Enter (complete/error) | Close the overlay and return to the main surface |
| Esc (loading) | Cancel only the side request and close, leaving the main turn running |
| ↑ / ↓ | Scroll the current answer |
| ← / → | Move between this session's side exchanges |
| c | Copy the current answer's raw Markdown |
| x | Clear all of this session's side exchanges and close |

Side exchanges live only in process memory: they never enter session JSONL, the main conversation record, checkpoints, validators, gates, permissions, or tool execution, and do not survive a process restart.
