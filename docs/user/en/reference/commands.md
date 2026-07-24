# Command cheatsheet

English | [简体中文](../../zh-CN/reference/commands.md)

Type a command starting with `/` in the input box; typing `/` opens a candidate menu (↑↓ to choose, Tab/Enter to complete, Esc to cancel). Each command owns its argument grammar.

## Session and context

| Command | Purpose |
|---|---|
| `/help` | List all commands |
| `/new` | Start a fresh session |
| `/resume` | List this project's sessions to resume; `/resume <n\|id>` resumes directly |
| `/rewind` (alias `/checkpoint`) | Rewind to a step in this session, optionally restoring guarded artifact files; Persistent Instruction configuration is not restored |
| `/compact [instructions]` | Compact the current session into a summary and continue, saving context |
| `/init [--force] [notes]` | Scan the project and draft a project-scope `VESICLE.md`; refuses an existing target unless `--force` backs it up and replaces it |
| `/context` | Show current context usage and window occupancy |
| `/instructions` | Show the Persistent Instructions active for the current engine (files, byte sizes, budget, and warnings) |
| `/btw <question>` | Ask a temporary side question about the current conversation without interrupting the turn; no args reopens the latest answer |

## Model and engine

| Command | Purpose |
|---|---|
| `/model [provider] [model]` | Switch provider/model; no args opens a picker |
| `/engine [id] [--summary [instructions]]` | Show or switch the Prism engine; `--summary` compacts before switching |
| `/stage <character-card-path> <scenario-card-path>` | Start a Stage narrative session from two cards |
| `/effort off\|low\|medium\|high\|xhigh\|max\|auto` | Control the model's thinking effort; `auto` restores the provider default |
| `/reasoning hidden\|collapsed\|expanded` | Control reasoning display (aliases off/preview/on) |
| `/theme dark\|light\|auto` | Switch the interface theme; `auto` follows the terminal's own mode, session-scoped and never persisted |
| `/workspace [path]` | Switch to the Workspace page (project-file workbench); with a path, locates that file or directory in the tree; `Ctrl+O` toggles between the two pages |

## Artifacts

| Command | Purpose |
|---|---|
| `/artifact [n\|path]` | Open an artifact in the Workspace page viewer; no args opens the latest one |
| `/validate <n\|path>` | Validate an artifact by number or path |

## Permissions and quality

| Command | Purpose |
|---|---|
| `/permissions [MANUAL\|INERTIA\|MOMENTUM\|YOLO]` | Show or set the tool approval mode |
| `/quality [off\|observe\|rewrite …]` | Configure the experimental Semantic Judge (off by default) |
| `/agents [handle\|stop <handle>\|retry]` | List, inspect, interrupt, or retry SubAgent delivery |

## Input-box keys

| Key | Purpose |
|---|---|
| Enter | Send while idle; queue ordinary messages and deferred commands while the Agent Loop is running |
| Ctrl+Enter | Newline |
| Up (running turn, empty box) | Retrieve the latest queued input for editing |
| Esc | Interrupt the current provider or tool operation and immediately process the next queued input |
| Double Esc (empty box, within 800ms) | Open the rewind picker |
| Double Esc (box has text) | Save the draft and clear it, without sending |
| Alt+V | Paste a clipboard image (only vision-capable models receive it) |
| Ctrl+Q | Exit Vesicle |

After a complete tool round, queued messages are added to the active conversation before its next provider request. If the loop completes without another tool boundary, the next queued input is processed immediately. Slash commands declare their own busy-turn behavior: `/help`, `/context`, `/reasoning`, `/theme`, `/workspace`, read-only settings forms, and `/agents` inspection or stop run immediately; `/artifact` and `/validate` wait for the current tool round; configuration changes, pickers, session commands, `/compact`, `/init`, and `/agents retry` wait for the Agent Loop. A picker pauses the remaining queue, and switching or resetting the session clears it.

## Workspace page keys

The Workspace page has three focus regions: the file tree, the viewer, and the input box. `F6` / `Shift+F6` cycle between them (the viewer is skipped when no file is open), and `Esc` steps focus back (viewer → tree → input box). Printable shortcuts only act in their focused region and never collide with the input box.

| Key | Purpose |
|---|---|
| Ctrl+P or / (tree focus) | Quick open: subsequence fuzzy match across project files; Enter opens, Esc closes |
| ↑ / ↓ (tree) | Move the selection |
| → / Enter (tree) | Expand a directory or open a file |
| ← (tree) | Collapse a directory or move to the parent |
| r (tree) | Refresh the directory |
| . (tree) | Show/hide dotfiles and noisy directories (`.git`, `node_modules`, `dist`, …) |
| ↑ / ↓ / PgUp / PgDn / Home / End (viewer) | Scroll |
| m (viewer) | Toggle Markdown files between source and preview |

The viewer is read-only: text files show numbered source lines, image and binary files show metadata; files over 512 KB or 2000 lines are truncated at the bound. Editing arrives in a later milestone.

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
